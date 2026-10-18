#!/usr/bin/env bash
set -euo pipefail
umask 077

PRAETORIUM_ROOT="${GITHUB_WORKSPACE:?}/praetorium"
PRAETORIUM_REVISION="$(git -C "$PRAETORIUM_ROOT" rev-parse HEAD)"
OUT="${RUNNER_TEMP:?}/praetorium-service-candidates-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
BIN="$OUT/bin"
TOOLKIT="$OUT/buildkit-release"
ARCHIVES="$OUT/archives"
METADATA="$OUT/metadata"
BUILD_ADDR="unix://$OUT/buildkitd.sock"
IMAGE_REPOSITORY="127.0.0.1:5000/praetorium/services"
REGISTRY_IMAGE="docker.io/library/registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e"
BUILDKIT_SHA256="14813b1fb2a40082114e6d386c6fc5e7dd5298176ce7ee1a18bc33e73e109ac3"
RECIPIENT_FINGERPRINT="4f117e60f1ff8af66e5eb9619dcf7142782162507ec558201b77d4ac62c2ad9b"
NODE_IMAGE="docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5"
BUILDKIT_CLIENT_IMAGE="docker.io/moby/buildkit@sha256:c1d0a1bc930a427f99f72220d1b263d6986d4592b21507fbc7f8bf7ecdaed004"
MAX_CMS_BYTES=$((4 * 1024 * 1024 * 1024))
CIPHERTEXT="$OUT/praetorium-service-images.cms"
BUILD_DAEMON_PID=""
KEEP_CIPHERTEXT=0

[[ "$GITHUB_REF" == "refs/heads/main" ]]
[[ "$PRAETORIUM_REVISION" == "$GITHUB_SHA" ]]
[[ "$PRAETORIUM_REVISION" =~ ^[a-f0-9]{40}$ ]]
test -z "$(git -C "$PRAETORIUM_ROOT" status --porcelain)"
test -n "${RECIPIENT_CERT_B64:-}"

mkdir -m 700 -p "$OUT" "$BIN" "$TOOLKIT" "$ARCHIVES" "$METADATA"
cleanup() {
  set +e
  if [[ -n "$BUILD_DAEMON_PID" ]]; then sudo kill "$BUILD_DAEMON_PID" 2>/dev/null; fi
  docker rm -f praetorium-service-candidates-registry >/dev/null 2>&1
  if [[ "$KEEP_CIPHERTEXT" == 1 && -s "$CIPHERTEXT" ]]; then
    sudo find "$OUT" -mindepth 1 -maxdepth 1 ! -name "$(basename "$CIPHERTEXT")" ! -name public-build-report.json -exec rm -rf -- {} +
  else
    sudo rm -rf -- "$OUT"
  fi
}
trap cleanup EXIT

printf '%s' "$RECIPIENT_CERT_B64" | base64 --decode > "$OUT/recipient-cert.pem"
actual_fingerprint="$(openssl x509 -in "$OUT/recipient-cert.pem" -noout -fingerprint -sha256 | sed 's/.*=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')"
test "$actual_fingerprint" = "$RECIPIENT_FINGERPRINT"
openssl x509 -in "$OUT/recipient-cert.pem" -checkend 3600 -noout
openssl cms -encrypt -binary -stream -aes-256-gcm \
  -in <(printf 'Praetorium candidate encryption preflight\n') \
  -out "$OUT/cms-preflight.der" -outform DER "$OUT/recipient-cert.pem"
openssl cms -cmsout -print -noout -inform DER -in "$OUT/cms-preflight.der" > "$OUT/cms-preflight.txt"
grep -qi 'AuthEnvelopedData' "$OUT/cms-preflight.txt"
grep -Eiq 'aes-256-gcm|id-aes256-GCM' "$OUT/cms-preflight.txt"
rm -f "$OUT/cms-preflight.der" "$OUT/cms-preflight.txt"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://github.com/moby/buildkit/releases/download/v0.34.0/buildkit-v0.34.0.linux-amd64.tar.gz \
  --output "$OUT/buildkit-v0.34.0.linux-amd64.tar.gz"
printf '%s  %s\n' "$BUILDKIT_SHA256" "$OUT/buildkit-v0.34.0.linux-amd64.tar.gz" | sha256sum --check
tar -xzf "$OUT/buildkit-v0.34.0.linux-amd64.tar.gz" -C "$TOOLKIT"
cp -a "$TOOLKIT/bin/." "$BIN/"
test -x "$BIN/buildkitd"
test -x "$BIN/buildctl"
test -x "$BIN/buildkit-runc"
export PATH="$BIN:$PATH"
buildkitd --version | grep -F 'v0.34.0'
buildctl --version | grep -F 'v0.34.0'

docker pull "$REGISTRY_IMAGE" >/dev/null
docker run --detach --name praetorium-service-candidates-registry --pull never \
  --publish 127.0.0.1:5000:5000 "$REGISTRY_IMAGE" >/dev/null

cat > "$OUT/buildkitd.toml" <<'TOML'
debug = false
[registry."127.0.0.1:5000"]
  http = true
  insecure = true
TOML
sudo env "PATH=$BIN:$PATH" "$BIN/buildkitd" --addr "$BUILD_ADDR" \
  --config "$OUT/buildkitd.toml" --root "$OUT/buildkit-root" > "$OUT/buildkitd.log" 2>&1 &
BUILD_DAEMON_PID=$!
ready=0
for attempt in $(seq 1 60); do
  if sudo "$BIN/buildctl" --addr "$BUILD_ADDR" debug workers >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = 1
curl --fail --silent --show-error --retry 30 --retry-delay 1 \
  http://127.0.0.1:5000/v2/ >/dev/null

metadata_digest() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))['containerimage.digest'];
if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) process.exit(1);
process.stdout.write(value);
NODE
}

archive_digest() {
  tar -xOf "$1" index.json | node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!Array.isArray(value.manifests) || value.manifests.length !== 1) process.exit(1);
    const digest = value.manifests[0].digest;
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) process.exit(1);
    process.stdout.write(digest);
  '
}

registry_digest() {
  local tag="$1"
  local digest
  digest="$(curl --fail --silent --show-error --head \
    --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://127.0.0.1:5000/v2/praetorium/services/manifests/$tag" |
    awk 'tolower($1) == "docker-content-digest:" { gsub("\r", "", $2); print $2 }')"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
  printf '%s' "$digest"
}

verify_image_outputs() {
  local metadata="$1"
  local archive="$2"
  local tag="$3"
  local expected from_archive from_registry
  expected="$(metadata_digest "$metadata")"
  from_archive="$(archive_digest "$archive")"
  from_registry="$(registry_digest "$tag")"
  test "$expected" = "$from_archive"
  test "$expected" = "$from_registry"
  printf '%s\n' "$expected"
}

build_service() {
  local service="$1" dockerfile="$2" package="$3"
  local tag="${service}-${PRAETORIUM_REVISION}"
  local archive="$ARCHIVES/${service}.oci.tar"
  local metadata="$METADATA/${service}.json"
  sudo "$BIN/buildctl" --addr "$BUILD_ADDR" build --progress plain \
    --frontend dockerfile.v0 \
    --local "context=$PRAETORIUM_ROOT" --local "dockerfile=$PRAETORIUM_ROOT" \
    --opt platform=linux/amd64 --opt "filename=$dockerfile" \
    --opt "build-arg:NODE_BUILD_IMAGE=$NODE_IMAGE" \
    --opt "build-arg:NODE_RUNTIME_IMAGE=$NODE_IMAGE" \
    --opt "build-arg:BUILDKIT_CLIENT_IMAGE=$BUILDKIT_CLIENT_IMAGE" \
    --opt 'build-arg:BUILDKIT_CLIENT_BUILDCTL_PATH=/usr/bin/buildctl' \
    --opt 'build-arg:PRAETORIUM_BUILDKIT_BUILDCTL_PATH=/usr/local/bin/buildctl' \
    --opt "build-arg:SERVICE_PACKAGE=$package" \
    --output "type=image,name=$IMAGE_REPOSITORY:$tag,push=true,oci-mediatypes=true" \
    --output "type=oci,dest=$archive,oci-mediatypes=true,compression=gzip" \
    --metadata-file "$metadata"
  verify_image_outputs "$metadata" "$archive" "$tag" > "$METADATA/${service}.digest"
}

build_service provisioner infrastructure/docker/service-runtime.Dockerfile @praetorium/provisioner
build_service instance-access infrastructure/docker/service-runtime.Dockerfile @praetorium/instance-access
build_service build-worker infrastructure/docker/build-worker.Dockerfile @praetorium/build-worker

node - "$PRAETORIUM_REVISION" "$IMAGE_REPOSITORY" "$ARCHIVES" "$METADATA" "$OUT/build-report.json" "$BUILDKIT_SHA256" "$BUILDKIT_CLIENT_IMAGE" "$NODE_IMAGE" "$RECIPIENT_FINGERPRINT" "$REGISTRY_IMAGE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [revision, repository, archiveDir, metadataDir, reportPath, buildkitSha256,
  buildkitClientImage, nodeImage, recipientFingerprint, registryImage] = process.argv.slice(2);
const services = {
  provisioner: { dockerfile: 'infrastructure/docker/service-runtime.Dockerfile', package: '@praetorium/provisioner' },
  'instance-access': { dockerfile: 'infrastructure/docker/service-runtime.Dockerfile', package: '@praetorium/instance-access' },
  'build-worker': { dockerfile: 'infrastructure/docker/build-worker.Dockerfile', package: '@praetorium/build-worker' }
};
const images = Object.fromEntries(Object.keys(services).map(service => {
  const digest = fs.readFileSync(path.join(metadataDir, `${service}.digest`), 'utf8').trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid digest for ${service}`);
  const archive = `${service}.oci.tar`;
  return [service, {
    reference: `${repository}@${digest}`,
    digest,
    dockerfile: services[service].dockerfile,
    servicePackage: services[service].package,
    archive,
    archiveSha256: execFileSync('sha256sum', [path.join(archiveDir, archive)], { encoding: 'utf8' }).split(/\s+/)[0],
    archiveSizeBytes: fs.statSync(path.join(archiveDir, archive)).size,
    buildkitMetadata: `metadata/${service}.json`
  }];
}));
fs.writeFileSync(reportPath, JSON.stringify({
  schemaVersion: 'praetorium-service-image-candidates/v1',
  praetoriumRevision: revision,
  platform: 'linux/amd64',
  buildkitVersion: 'v0.34.0',
  buildkitArchiveSha256: buildkitSha256,
  registryImage,
  nodeBuildAndRuntimeImage: nodeImage,
  buildkitClientImage,
  recipientCertificateFingerprintSha256: recipientFingerprint,
  registryPublication: 'disposable loopback registry only',
  publicRegistryPublication: false,
  images
}, null, 2) + '\n', { mode: 0o600 });
NODE

OCI_BYTES=0
for archive in "$ARCHIVES/provisioner.oci.tar" "$ARCHIVES/instance-access.oci.tar" "$ARCHIVES/build-worker.oci.tar"; do
  test -s "$archive"
  OCI_BYTES=$((OCI_BYTES + $(stat -c '%s' "$archive")))
done
if [[ "$OCI_BYTES" -gt "$((MAX_CMS_BYTES - 16 * 1024 * 1024))" ]]; then
  printf 'OCI archive bytes %s exceed the reviewed 4 GiB encrypted-artifact cap before tar/CMS overhead.\n' "$OCI_BYTES" >&2
  exit 1
fi

tar -cf - -C "$OUT" \
  build-report.json \
  metadata/provisioner.json metadata/instance-access.json metadata/build-worker.json \
  archives/provisioner.oci.tar archives/instance-access.oci.tar archives/build-worker.oci.tar |
  openssl cms -encrypt -binary -stream -aes-256-gcm \
    -in /dev/stdin -out "$CIPHERTEXT" -outform DER "$OUT/recipient-cert.pem"
CIPHERTEXT_BYTES="$(stat -c '%s' "$CIPHERTEXT")"
if [[ "$CIPHERTEXT_BYTES" -gt "$MAX_CMS_BYTES" ]]; then
  printf 'Encrypted candidate evidence is %s bytes, over the 4 GiB cap.\n' "$CIPHERTEXT_BYTES" >&2
  exit 1
fi
CIPHERTEXT_SHA256="$(sha256sum "$CIPHERTEXT" | awk '{print $1}')"
node - "$OUT/build-report.json" "$CIPHERTEXT" "$OUT/public-build-report.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [encryptedReportPath, ciphertextPath, publicReportPath] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(encryptedReportPath, 'utf8'));
const images = Object.fromEntries(Object.entries(report.images).map(([service, image]) => [service, {
  digest: image.digest,
  archive: image.archive,
  archiveSha256: image.archiveSha256,
  archiveSizeBytes: image.archiveSizeBytes
}]));
const ciphertextSha256 = execFileSync('sha256sum', [ciphertextPath], { encoding: 'utf8' }).split(/\s+/)[0];
fs.writeFileSync(publicReportPath, JSON.stringify({
  schemaVersion: 'praetorium-service-image-candidate-digests/v1',
  praetoriumRevision: report.praetoriumRevision,
  platform: report.platform,
  images,
  encryptedArtifact: {
    fileName: path.basename(ciphertextPath),
    sha256: ciphertextSha256,
    sizeBytes: fs.statSync(ciphertextPath).size
  }
}, null, 2) + '\n', { mode: 0o600 });
NODE

{

  printf '# Praetorium service image candidate build\n\n'
  printf 'Praetorium revision: `%s`\n\n' "$PRAETORIUM_REVISION"
  printf 'Each OCI manifest digest matched BuildKit metadata, the exported OCI archive, and a loopback registry HEAD readback.\n\n'
  node - "$OUT/build-report.json" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const [service, image] of Object.entries(report.images))
  process.stdout.write(`- ${service}: \`${image.reference}\`\n`);
NODE
  printf '\nCiphertext-only artifact: `%s` bytes, SHA-256 `%s`; retention is one day.\n' "$CIPHERTEXT_BYTES" "$CIPHERTEXT_SHA256"
  printf 'The registry was bound to 127.0.0.1; no public image push, release, deployment, or OIDC signing occurred.\n'
} >> "$GITHUB_STEP_SUMMARY"
KEEP_CIPHERTEXT=1
