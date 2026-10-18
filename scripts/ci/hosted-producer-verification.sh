#!/usr/bin/env bash
set -euo pipefail
umask 077

PRAETORIUM_ROOT="$GITHUB_WORKSPACE/praetorium"
SCRIPTORIUM_ROOT="$GITHUB_WORKSPACE/scriptorium"
OUT="$RUNNER_TEMP/scriptorium-producer-evidence-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
BIN="$OUT/bin"
TOOLKIT="$OUT/buildkit-release"
BUILD_ADDR="unix://$OUT/buildkitd.sock"
IMAGE_REPOSITORY="127.0.0.1:5000/scriptorium/producer"
REGISTRY_IMAGE="docker.io/library/registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e"
BUILDKIT_SHA256="14813b1fb2a40082114e6d386c6fc5e7dd5298176ce7ee1a18bc33e73e109ac3"
RECIPIENT_FINGERPRINT="4f117e60f1ff8af66e5eb9619dcf7142782162507ec558201b77d4ac62c2ad9b"
MAX_EVIDENCE_CMS_BYTES=$((4 * 1024 * 1024 * 1024))

test -d "$PRAETORIUM_ROOT"
test -d "$SCRIPTORIUM_ROOT"
test -n "$SCRIPTORIUM_REVISION"
test -n "$RECIPIENT_CERT_B64"
test "$(git -C "$SCRIPTORIUM_ROOT" rev-parse HEAD)" = "$SCRIPTORIUM_REVISION"
test -z "$(git -C "$SCRIPTORIUM_ROOT" status --porcelain)"
test "$(git -C "$SCRIPTORIUM_ROOT" remote get-url origin)" = "https://github.com/yohn-jp/scriptorium.git"

mkdir -m 700 -p "$OUT" "$BIN" "$TOOLKIT" "$OUT/metadata" "$OUT/build-inputs"
printf '%s' "$RECIPIENT_CERT_B64" | base64 --decode > "$OUT/recipient-cert.pem"
actual_fingerprint="$(openssl x509 -in "$OUT/recipient-cert.pem" -noout -fingerprint -sha256 | sed 's/.*=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')"
test "$actual_fingerprint" = "$RECIPIENT_FINGERPRINT"
openssl x509 -in "$OUT/recipient-cert.pem" -checkend 3600 -noout
openssl x509 -in "$OUT/recipient-cert.pem" -noout -subject -serial -dates > "$OUT/recipient-cert-public.txt"

printf 'CMS AES-GCM stream preflight\n' > "$OUT/cms-preflight.txt"
openssl cms -encrypt -binary -stream -aes-256-gcm -in "$OUT/cms-preflight.txt" -out "$OUT/cms-preflight.der" -outform DER "$OUT/recipient-cert.pem"
openssl cms -cmsout -print -noout -inform DER -in "$OUT/cms-preflight.der" > "$OUT/cms-preflight-asn1.txt"
grep -qi 'AuthEnvelopedData' "$OUT/cms-preflight-asn1.txt"
grep -Eiq 'aes-256-gcm|id-aes256-GCM' "$OUT/cms-preflight-asn1.txt"
rm -f "$OUT/cms-preflight.txt" "$OUT/cms-preflight.der" "$OUT/cms-preflight-asn1.txt"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2   https://github.com/moby/buildkit/releases/download/v0.34.0/buildkit-v0.34.0.linux-amd64.tar.gz   --output "$OUT/buildkit-v0.34.0.linux-amd64.tar.gz"
printf '%s  %s\n' "$BUILDKIT_SHA256" "$OUT/buildkit-v0.34.0.linux-amd64.tar.gz" | sha256sum --check
tar -xzf "$OUT/buildkit-v0.34.0.linux-amd64.tar.gz" -C "$TOOLKIT"
cp -a "$TOOLKIT/bin/." "$BIN/"
test -x "$BIN/buildkitd"
test -x "$BIN/buildctl"
test -x "$BIN/buildkit-runc"
export PATH="$BIN:$PATH"
buildkitd --version | grep -F 'v0.34.0'
buildctl --version | grep -F 'v0.34.0'

SCRIPTORIUM_DOCKERFILE_SHA256="$(sha256sum "$SCRIPTORIUM_ROOT/Dockerfile" | awk '{print $1}')"
test "$SCRIPTORIUM_DOCKERFILE_SHA256" = "005b540188d5337e103bb4e5aba17c0ae4be3439c17d02b170a6b3d9a28ce350"

corepack enable --install-directory "$BIN" pnpm
(
  cd "$SCRIPTORIUM_ROOT"
  corepack pnpm@12.10.1 install --frozen-lockfile
  corepack pnpm@12.10.1 build
)

docker pull "$REGISTRY_IMAGE" >/dev/null
docker run --detach --name scriptorium-producer-verification-registry --pull never   --publish 127.0.0.1:5000:5000 "$REGISTRY_IMAGE" >/dev/null
BUILD_DAEMON_PID=""
cleanup() {
  set +e
  if [ -n "$BUILD_DAEMON_PID" ]; then sudo kill "$BUILD_DAEMON_PID" 2>/dev/null; fi
  docker rm -f scriptorium-producer-verification-registry >/dev/null 2>&1
}
trap cleanup EXIT

cat > "$OUT/buildkitd.toml" <<'TOML'
debug = false
[registry."127.0.0.1:5000"]
  http = true
  insecure = true
TOML

sudo env "PATH=$BIN:$PATH" "$BIN/buildkitd" --addr "$BUILD_ADDR" --config "$OUT/buildkitd.toml" --root "$OUT/buildkit-root" > "$OUT/buildkitd.log" 2>&1 &
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
curl --fail --silent --show-error --retry 30 --retry-delay 1 http://127.0.0.1:5000/v2/ >/dev/null

metadata_digest() {
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))["containerimage.digest"];
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) process.exit(1);
    process.stdout.write(value);
  ' "$1"
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
  curl --fail --silent --show-error --head     --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'     "http://127.0.0.1:5000/v2/scriptorium/producer/manifests/$1" |
    awk 'tolower($1) == "docker-content-digest:" { gsub("\r", "", $2); print $2 }'
}

verify_image_outputs() {
  local tag="$1"
  local metadata="$2"
  local archive="$3"
  local expected
  local from_archive
  local from_registry
  expected="$(metadata_digest "$metadata")"
  from_archive="$(archive_digest "$archive")"
  from_registry="$(registry_digest "$tag")"
  test "$expected" = "$from_archive"
  test "$expected" = "$from_registry"
}

build_dockerfile_image() {
  local target="$1"
  local tag="$2"
  local metadata="$3"
  local archive="$4"
  shift 4
  sudo "$BIN/buildctl" --addr "$BUILD_ADDR" build --progress plain --frontend dockerfile.v0     --local "context=$SCRIPTORIUM_ROOT" --local "dockerfile=$SCRIPTORIUM_ROOT"     --opt platform=linux/amd64 --opt "target=$target"     --opt "build-arg:SCRIPTORIUM_PRODUCER_REVISION=$SCRIPTORIUM_REVISION" "$@"     --output "type=image,name=$tag,push=true,oci-mediatypes=true"     --output "type=oci,dest=$archive,oci-mediatypes=true,compression=gzip"     --metadata-file "$metadata"
  verify_image_outputs "${tag##*:}" "$metadata" "$archive"
}

build_composition() {
  local name="$1"
  local input_file="$2"
  local tag="$IMAGE_REPOSITORY:composition-$name-$SCRIPTORIUM_REVISION"
  local metadata="$OUT/composition-$name-metadata.json"
  local archive="$OUT/composition-$name.oci.tar"
  local encoded
  encoded="$(cat "$input_file")"
  sudo "$BIN/buildctl" --addr "$BUILD_ADDR" build --progress plain --frontend gateway.v0     --opt "source=$BUILD_KIT_IMAGE"     --opt "scriptorium.build-input.v1=$encoded"     --output "type=image,name=$tag,push=true,oci-mediatypes=true"     --output "type=oci,dest=$archive,oci-mediatypes=true,compression=gzip"     --metadata-file "$metadata"
  verify_image_outputs "${tag##*:}" "$metadata" "$archive"
}

RUNTIME_BASE_TAG="$IMAGE_REPOSITORY:runtime-base-$SCRIPTORIUM_REVISION"
BUILD_KIT_TAG="$IMAGE_REPOSITORY:build-kit-$SCRIPTORIUM_REVISION"
RUNTIME_BASE_METADATA="$OUT/runtime-base-metadata.json"
BUILD_KIT_METADATA="$OUT/build-kit-metadata.json"
RUNTIME_BASE_ARCHIVE="$OUT/runtime-base.oci.tar"
BUILD_KIT_ARCHIVE="$OUT/build-kit.oci.tar"

build_dockerfile_image runtime-base "$RUNTIME_BASE_TAG" "$RUNTIME_BASE_METADATA" "$RUNTIME_BASE_ARCHIVE"
build_dockerfile_image buildkit "$BUILD_KIT_TAG" "$BUILD_KIT_METADATA" "$BUILD_KIT_ARCHIVE"   --opt "build-arg:SCRIPTORIUM_DOCKERFILE_SHA256=$SCRIPTORIUM_DOCKERFILE_SHA256"

RUNTIME_BASE_DIGEST="$(metadata_digest "$RUNTIME_BASE_METADATA")"
BUILD_KIT_DIGEST="$(metadata_digest "$BUILD_KIT_METADATA")"
RUNTIME_BASE_IMAGE="$IMAGE_REPOSITORY@$RUNTIME_BASE_DIGEST"
BUILD_KIT_IMAGE="$IMAGE_REPOSITORY@$BUILD_KIT_DIGEST"
export RUNTIME_BASE_DIGEST BUILD_KIT_DIGEST RUNTIME_BASE_IMAGE BUILD_KIT_IMAGE
node "$SCRIPTORIUM_ROOT/scripts/hosted-build.mjs" catalog   --producer-revision "$SCRIPTORIUM_REVISION"   --runtime-base-digest "$RUNTIME_BASE_DIGEST"   --build-kit-digest "$BUILD_KIT_DIGEST"   --out "$OUT/build-catalog.json"

SCRIPTORIUM_ROOT="$SCRIPTORIUM_ROOT" CATALOG_PATH="$OUT/build-catalog.json"   BUILD_INPUT_OUTPUT_DIR="$OUT/build-inputs"   node "$PRAETORIUM_ROOT/scripts/ci/make-build-inputs.mjs"

build_composition core "$OUT/build-inputs/core.input"
build_composition story "$OUT/build-inputs/story.input"

CORE_DIGEST="$(metadata_digest "$OUT/composition-core-metadata.json")"
CORE_IMAGE="$IMAGE_REPOSITORY@$CORE_DIGEST"
docker pull "$CORE_IMAGE" >/dev/null
docker run --rm --network none --pull never --entrypoint node "$CORE_IMAGE"   -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))'   /usr/share/scriptorium/runtime-metadata.json > "$OUT/runtime-metadata.json"

node "$SCRIPTORIUM_ROOT/scripts/hosted-attestation.mjs" statement \
  --catalog "$OUT/build-catalog.json" \
  --runtime-metadata "$OUT/runtime-metadata.json" \
  --runtime-base-image "$RUNTIME_BASE_IMAGE" \
  --build-kit-image "$BUILD_KIT_IMAGE" \
  --statement-out "$OUT/provenance.statement.json"

STORY_DIGEST="$(metadata_digest "$OUT/composition-story-metadata.json")"
SOURCE_DIGEST="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).sourceDigest)' "$OUT/build-catalog.json")"
RECIPE_DIGEST="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).recipeDigest)' "$OUT/build-catalog.json")"
LOCK_DIGEST="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).lockDigest)' "$OUT/build-catalog.json")"

for archive in "$RUNTIME_BASE_ARCHIVE" "$BUILD_KIT_ARCHIVE" "$OUT/composition-core.oci.tar" "$OUT/composition-story.oci.tar"; do
  test -s "$archive"
done
OCI_BYTES=0
for archive in "$RUNTIME_BASE_ARCHIVE" "$BUILD_KIT_ARCHIVE" "$OUT/composition-core.oci.tar" "$OUT/composition-story.oci.tar"; do
  OCI_BYTES=$((OCI_BYTES + $(stat -c '%s' "$archive")))
done
TAR_OVERHEAD_RESERVE=$((16 * 1024 * 1024))
if [ "$OCI_BYTES" -gt "$((MAX_EVIDENCE_CMS_BYTES - TAR_OVERHEAD_RESERVE))" ]; then
  printf 'OCI archive bytes %s exceed the 4 GiB encrypted-evidence cap before tar/CMS overhead.\n' "$OCI_BYTES" >&2
  exit 1
fi

tar -cf - -C "$OUT" \
  runtime-base.oci.tar \
  build-kit.oci.tar \
  composition-core.oci.tar \
  composition-story.oci.tar |
  openssl cms -encrypt -binary -stream -aes-256-gcm \
    -in /dev/stdin -out "$OUT/producer-evidence.cms" -outform DER "$OUT/recipient-cert.pem"
ENCRYPTED_EVIDENCE_BYTES="$(stat -c '%s' "$OUT/producer-evidence.cms")"
if [ "$ENCRYPTED_EVIDENCE_BYTES" -gt "$MAX_EVIDENCE_CMS_BYTES" ]; then
  rm -f "$OUT/producer-evidence.cms"
  printf 'Encrypted evidence measured %s bytes, exceeding the reviewed 4 GiB cap (%s bytes).\n' \
    "$ENCRYPTED_EVIDENCE_BYTES" "$MAX_EVIDENCE_CMS_BYTES" >&2
  exit 1
fi
ENCRYPTED_EVIDENCE_SHA256="$(sha256sum "$OUT/producer-evidence.cms" | awk '{print $1}')"
RUNTIME_METADATA_SHA256="$(sha256sum "$OUT/runtime-metadata.json" | awk '{print $1}')"
CATALOG_SHA256="$(sha256sum "$OUT/build-catalog.json" | awk '{print $1}')"
STATEMENT_SHA256="$(sha256sum "$OUT/provenance.statement.json" | awk '{print $1}')"

if [ "${PUBLISH_PUBLIC_PRODUCER_IMAGES:-false}" = "true" ]; then
  REGISTRY_PUBLICATION="deferred to separate Praetorium GHCR publisher after signer success"
  ARTIFACT_PUBLICATION="ciphertext evidence plus two one-day OCI publication inputs"
else
  REGISTRY_PUBLICATION="loopback disposable registry only"
  ARTIFACT_PUBLICATION="ciphertext-only one-day GitHub Actions artifact"
fi

cp "$OUT/build-catalog.json" "$OUT/metadata/"
cp "$OUT/runtime-metadata.json" "$OUT/metadata/"
cp "$OUT/provenance.statement.json" "$OUT/metadata/"
cp "$RUNTIME_BASE_METADATA" "$OUT/metadata/runtime-base-metadata.json"
cp "$BUILD_KIT_METADATA" "$OUT/metadata/build-kit-metadata.json"
cp "$OUT/composition-core-metadata.json" "$OUT/metadata/"
cp "$OUT/composition-story-metadata.json" "$OUT/metadata/"
cp "$OUT/build-inputs/build-inputs.json" "$OUT/metadata/"
cat > "$OUT/metadata/build-report.json" <<REPORT
{
  "schemaVersion": "praetorium-scriptorium-producer-verification/v1",
  "producerRevision": "$SCRIPTORIUM_REVISION",
  "sourceOrigin": "https://github.com/yohn-jp/scriptorium",
  "dockerfileSha256": "$SCRIPTORIUM_DOCKERFILE_SHA256",
  "sourceDigest": "$SOURCE_DIGEST",
  "recipeDigest": "$RECIPE_DIGEST",
  "lockDigest": "$LOCK_DIGEST",
  "cosignIdentity": "https://github.com/yohn-jp/praetorium/.github/workflows/scriptorium-producer-verification.yml@refs/heads/main",
  "cosignIssuer": "https://token.actions.githubusercontent.com",
  "recipientCertificateFingerprintSha256": "$RECIPIENT_FINGERPRINT",
  "imageRepository": "$IMAGE_REPOSITORY",
  "images": {
    "runtime-base": {"digest": "$RUNTIME_BASE_DIGEST", "reference": "$RUNTIME_BASE_IMAGE", "archive": "runtime-base.oci.tar", "archiveSizeBytes": $(stat -c '%s' "$RUNTIME_BASE_ARCHIVE")},
    "build-kit": {"digest": "$BUILD_KIT_DIGEST", "reference": "$BUILD_KIT_IMAGE", "archive": "build-kit.oci.tar", "archiveSizeBytes": $(stat -c '%s' "$BUILD_KIT_ARCHIVE")},
    "composition-core": {"digest": "$CORE_DIGEST", "reference": "$CORE_IMAGE", "archive": "composition-core.oci.tar", "archiveSizeBytes": $(stat -c '%s' "$OUT/composition-core.oci.tar")},
    "composition-story": {"digest": "$STORY_DIGEST", "reference": "$IMAGE_REPOSITORY@$STORY_DIGEST", "archive": "composition-story.oci.tar", "archiveSizeBytes": $(stat -c '%s' "$OUT/composition-story.oci.tar")}
  },
  "catalogSha256": "$CATALOG_SHA256",
  "runtimeMetadataSha256": "$RUNTIME_METADATA_SHA256",
  "statementSha256": "$STATEMENT_SHA256",
  "encryptedEvidence": {
    "fileName": "producer-evidence.cms",
    "sha256": "$ENCRYPTED_EVIDENCE_SHA256",
    "sizeBytes": $ENCRYPTED_EVIDENCE_BYTES,
    "maxSizeBytes": $MAX_EVIDENCE_CMS_BYTES
  },
  "registryPublication": "$REGISTRY_PUBLICATION",
  "artifactPublication": "$ARTIFACT_PUBLICATION"
}
REPORT

{
  printf '# Scriptorium producer verification result\n\n'
  printf 'Producer revision: %s\n' "$SCRIPTORIUM_REVISION"
  printf 'Dockerfile SHA-256: %s\n' "$SCRIPTORIUM_DOCKERFILE_SHA256"
  printf 'Source digest: %s\n' "$SOURCE_DIGEST"
  printf 'Runtime Base digest: %s\n' "$RUNTIME_BASE_DIGEST"
  printf 'Build Kit digest: %s\n' "$BUILD_KIT_DIGEST"
  printf 'Core composition digest: %s\n' "$CORE_DIGEST"
  printf 'Story composition digest: %s\n' "$STORY_DIGEST"
  printf 'Encrypted evidence size: %s / %s bytes\n' "$ENCRYPTED_EVIDENCE_BYTES" "$MAX_EVIDENCE_CMS_BYTES"
  if [ "${PUBLISH_PUBLIC_PRODUCER_IMAGES:-false}" = "true" ]; then
    printf 'Uploads: ciphertext evidence, separate public metadata, and only the Runtime Base/Build Kit OCI publication inputs; one-day retention.\n'
    printf 'Registry publication runs in a separate job only after signed metadata validation; anonymous GHCR availability is checked separately.\n'
    printf 'Core and Story OCI archives remain only inside ciphertext evidence.\n'
  else
    printf 'Uploads: ciphertext-only OCI evidence plus separate public metadata; one-day retention.\n'
    printf 'No plaintext OCI archive is uploaded to Actions artifacts.\n'
  fi
  printf 'Signing and source validation are performed in a separate metadata-only job.\n'
  printf 'This records actual producer builds and compositions only; it does not certify Control Plane admission or hosted runtime acceptance.\n'
} >> "$GITHUB_STEP_SUMMARY"
