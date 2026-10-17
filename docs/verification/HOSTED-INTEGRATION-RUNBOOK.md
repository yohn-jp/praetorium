# Hosted Praetorium and Scriptorium integration runbook

This runbook describes the disposable end-to-end path for the Hosted campaign.
The integrated production source cuts are Praetorium
`a669f5c16faa85d5fcc162241b793eab734d46c2` and Scriptorium
`008d5c429ec279a424cafd5b8c4cbee70a613b8e`. Source implementation and local
checks do not certify the full product path. Use the migration ledger and
producer status for measured artifact and acceptance evidence; an accepted
Platform artifact remains unset until its real admission and product gates
pass. Replace deployment variables below with measured immutable references
and the owner inventory for that run. Actual candidate digests, source cuts and
production inspector results are in [the artifact record](HOSTED-ARTIFACTS-008d5c4.json).
Provisioner includes the lifecycle and empty-queue fixes at `a669f5c`;
Build Worker includes the lifecycle fix at `6cd9d26`;
Instance Access uses unchanged source at `94d3902`.

The procedure is for resources explicitly owned as disposable and nonproduction.
It does not authorize production Worker, DNS, registry, Kubernetes, key, or data
changes. Use a private owner inventory and keep all credentials, authored work,
test tokens, and private registry files outside both repositories.

## 1. Freeze source and producer inputs

Use clean checkouts at the final integration commits. A dirty tree is not an
acceptable source for an image whose source and recipe digests are being
attested.

```sh
export PRAETORIUM_ROOT=/path/to/praetorium
export SCRIPTORIUM_ROOT=/path/to/scriptorium
export PRAETORIUM_SOURCE_SHA='<integrated-praetorium-commit>'
export SCRIPTORIUM_SOURCE_SHA='<integrated-scriptorium-commit>'

git -C "$PRAETORIUM_ROOT" status --short
git -C "$PRAETORIUM_ROOT" rev-parse HEAD
git -C "$SCRIPTORIUM_ROOT" status --short
git -C "$SCRIPTORIUM_ROOT" rev-parse HEAD
```

Stop if either checkout differs from its recorded SHA or has unreviewed source
changes. Run the Praetorium checks from the repository root. Ensure nested `pnpm` commands resolve through Corepack rather than a different globally installed pnpm. An owner-private tool directory can hold the shim:

```sh
export OWNER_TOOL_BIN=/private/owner/tools/corepack
mkdir -p "$OWNER_TOOL_BIN"
corepack enable --install-directory "$OWNER_TOOL_BIN" pnpm
export PATH="$OWNER_TOOL_BIN:$PATH"
corepack pnpm@11.18.0 install --frozen-lockfile
corepack pnpm@11.18.0 check
```

Run Scriptorium checks with its declared `corepack pnpm@12.10.1` toolchain and save actual output. The integrated producer implements the hosted catalog command below:

```sh
export PRODUCER_REVISION='<40-hex-commit>'
export RUNTIME_BASE_DIGEST='sha256:<64-hex-digest>'
export BUILDKIT_FRONTEND_DIGEST='sha256:<64-hex-digest>'
export PRODUCER_OUTPUT_DIR=/private/owner/evidence/producer

node scripts/hosted-build.mjs catalog \
  --producer-revision "$PRODUCER_REVISION" \
  --runtime-base-digest "$RUNTIME_BASE_DIGEST" \
  --build-kit-digest "$BUILDKIT_FRONTEND_DIGEST" \
  --out "$PRODUCER_OUTPUT_DIR/build-catalog.json"
```

Record the source commit and tree, Runtime Base and Build Kit digests, catalog
digest, runtime-metadata digest, the producer SLSA bundle reference and signer
identity, and each later composition image and manifest digest. The accepted
producer release must bind those exact catalog and runtime metadata subjects
to the immutable runtime image. A published Core/Full preset, a successful
catalog command, or an OCI manifest by itself is not Hosted producer admission.
Generate the canonical source statement and Sigstore bundle using Scriptorium
[`scripts/hosted-attestation.mjs`](https://github.com/yohn-jp/scriptorium/blob/008d5c429ec279a424cafd5b8c4cbee70a613b8e/scripts/hosted-attestation.mjs)
and its [operator instructions](https://github.com/yohn-jp/scriptorium/blob/008d5c429ec279a424cafd5b8c4cbee70a613b8e/docs/hosted-producer-attestation.md).
Extract runtime metadata from the digest-pinned composed Core image; Runtime
Base has no packaged metadata sidecar. Statement-only output is unsigned.

The fixed BuildKit runner submits selections through the real Control Plane
resolver and Build Worker; do not substitute a direct CLI composition or a
fixture artifact for that path.

The Build Worker signs derived candidates with its operator-owned Ed25519 key.
The matching public key and key ID belong in Control Plane `BUILD_POLICY_JSON`;
they are separate from Scriptorium's Sigstore identity. Producer source-release
metadata is verified against the Sigstore trust root and the exact configured
`RELEASE_POLICY_JSON.signerIdentityAllowlist` (certificate subject and, when
configured, issuer). The verified SLSA bundle must bind the runtime image,
`scriptorium-build/v1/catalog.json`, and
`scriptorium-platform/v1/runtime-metadata.json`. Do not allow an unpinned
identity or a mutable tag to stand in for the signed subjects.

## 2. Reserve one owned disposable environment

Copy `infrastructure/test/acceptance-inventory.json` to a private path and
complete the exact schema in
`infrastructure/test/acceptance-inventory.schema.json`. The checked-in draft
has a placeholder owner and all seven resources marked missing. Do not change
it to claim ownership. In the private copy, set the real owner identity, unique
environment name, future timezone-bearing expiry, cleanup procedure, and all
seven resources to `available` only after each is provisioned and verified.
Every resource must repeat the same owner identity, set `disposable: true` and
`production: false`, and reference its real owner-managed resource or private
configuration file. The inventory is an ownership declaration; it does not
itself verify that a service or cluster works.

The seven categories are `workers-d1-do`, `github-access`,
`buildkit-registry`, `kubernetes-isolation`, `browser-entry`,
`producer-recovery`, and `stable-rollout`. Use each runner's fixed inputs and
constraints in [GitHub access](GITHUB-ACCESS.md), [BuildKit and
registry](T14-BUILDKIT-REGISTRY-RUNNER.md), [Kubernetes
isolation](KUBERNETES-ISOLATION.md), and [browser
entry](BROWSER-ENTRY.md). The producer-recovery and stable-rollout runners read
the corresponding inventory references and share the exact browser, GitHub,
Kubernetes, producer-status, and candidate-manifest identities; follow their
schemas in `tests/integration/producer-recovery.test.mjs` and
`tests/integration/stable-rollout.test.mjs` at the final source SHA.

Before any product operation, run the effect-free ownership plans:

```sh
export ACCEPTANCE_INVENTORY=/absolute/path/to/owned-acceptance-inventory.json
export OWNER_REGISTRY_CA_FILE=/absolute/path/to/owner-registry-ca.pem
node scripts/preflight-integration.mjs --environment "$ACCEPTANCE_INVENTORY" --plan
node scripts/verify-integration.mjs --environment "$ACCEPTANCE_INVENTORY" \
  --ca-file "$OWNER_REGISTRY_CA_FILE" --plan
```

The plans must have no schema or ownership errors. `NOT_CHECKED` is not a pass;
the preflight does not inspect the current Kubernetes context or prove any live
resource. Each fixed runner also requires its own current-UID, owner-only input
files and checks the actual endpoint or identity before mutation.

### GitHub App and test users

Use an owner-controlled GitHub App installed only on throwaway private
repositories. Use numeric repository IDs. Prepare a writer/maintainer and a
separate read-only user; both must complete the real GitHub OAuth flow through
the owned Gateway. The App installation must be able to read repository
metadata and perform the repository-content operations required by the
product. Keep its installation restricted to the test repositories. Prepare a
separate sibling repository to test cross-repository rejection and a separate
private runtime repository for clone, fetch, token renewal, and authorized
push. The fixed GitHub runner requires current writer and reader session/CSRF
cookies and their GitHub OAuth user tokens, plus App ID, installation ID, PEM,
and repository IDs in private config files. Never seed fake Gateway sessions or
paste the App key, user tokens, cookies, or repository content into command
output.

Use a synthetic manuscript-free tree in the acceptance repositories. Browser
storage state may contain GitHub cookies only; Praetorium session cookies must
be minted by the real OAuth callback. The runner config's browser write probe
must be a safe, bounded side effect against the disposable producer and must be
reconciled before cleanup.

## 3. Prepare matching trust, keys, policies, and routes

Keep these credentials separate. They have different issuers and consumers.

| Credential or policy                         | Purpose and public verification path                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway `GATEWAY_SIGNING_KEY`                | Private P-256 JWK plus key ID for Hosted browser grants. Publish only its matching active public JWK in `GATEWAY_KV`; `GET /.well-known/jwks.json` exposes the public key.      |
| Control Plane `RUNTIME_CONTROL_SIGNING_KEY`  | Separate P-256 signing key for short-lived runtime-control credentials; `GET /.well-known/control-jwks.json` serves its public key.                                             |
| Control Plane `RUNTIME_IDENTITY_SIGNING_KEY` | Separate `{kid, privateKeyJwk}` ES256 identity issuer used by Provisioner. `GET /.well-known/runtime-identity-jwks.json` serves only public P-256 key fields.                   |
| Build Worker Ed25519 key                     | Signs build-candidate statements. The mounted private key and configured key ID must match the public builder entry in `BUILD_POLICY_JSON`.                                     |
| Producer Sigstore identity                   | Authenticates the producer SLSA bundle. Pin the exact certificate subject and issuer policy in `RELEASE_POLICY_JSON`; this is distinct from the builder key.                    |
| GitHub App private key                       | Signs App installation-token requests. It is not a Praetorium, Scriptorium, Gateway, or builder signing key.                                                                    |
| Service credentials                          | Use distinct values for Gateway↔Control Plane, Provisioner↔Control Plane, Build Worker↔Control Plane, release operator, credential retirement, and Instance Access↔Gateway. |

Set the Gateway's exact `GATEWAY_ORIGIN`, `CONTROL_PLANE_ORIGIN`,
`GATEWAY_INSTANCE_HOSTNAME_SUFFIX`, allowed repository owner, App ID, OAuth
client ID, and encryption-key ID. Its separate secrets include
`GITHUB_OAUTH_CLIENT_SECRET`, `GATEWAY_GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`,
`CONTROL_PLANE_GATEWAY_AUTH`, `RUNTIME_CREDENTIAL_RETIREMENT_AUTH`,
`INSTANCE_ACCESS_SERVICE_AUTH_TOKEN`, three independent session/credential/
handoff digest peppers, `GATEWAY_TOKEN_ENCRYPTION_KEY`, and
`GATEWAY_SIGNING_KEY`. The Control Plane and Gateway share only the exact
`CONTROL_PLANE_GATEWAY_AUTH` value and the credential-retirement secret; keep
both distinct from every other service secret.

Control Plane public vars must use those same exact HTTPS origins and suffix.
Configure the complete `BUILD_POLICY_JSON`: HTTPS registry origin, single
approved output repository, image/request limits, target platform, runtime
resource ceilings, cache-retention limits, and builder Ed25519 public keys.
`BUILD_WORKER_AUTH_TOKEN` must match the mounted Build Worker service-token
file. `REGISTRY_PULL_CREDENTIAL` is a separate optional registry-read
credential. Configure `RELEASE_POLICY_JSON` only with the owner's selected
disposable canary binding, actual operator actor, worker/cluster IDs, and
nonempty producer signer allowlist; pair it with a separate
`RELEASE_OPERATOR_TOKEN`. Do not copy example cache limits, repo IDs, actors,
or signer identities from fixtures.

Keep external and internal routes consistent:

- `CONTROL_PLANE_ORIGIN` is the exact trusted public HTTPS issuer used by
  Gateway, Build Worker, Provisioner, and the runtime assignment.
- `GATEWAY_ORIGIN` is the browser-facing HTTPS Gateway origin and the grant
  issuer used by Scriptorium. The Control Plane's service binding points to
  that Gateway Worker; Gateway's `CONTROL_PLANE` service binding points back
  to the Control Plane Worker.
- The stable instance DNS name is derived from the unchanged instance ID and
  owned hostname suffix. Its TLS certificate, SNI, Host header, Traefik route,
  Instance Access suffix, and browser origin must all agree. Runtime replacement
  changes the service behind that name, not the origin, so host-only cookies,
  IndexedDB and the browser journal remain available after restart.
- `gatewayServiceUrl` must be reachable from the Instance Access Pod. The
  Control Plane and Gateway origins must be reachable from their consumers.
  Record explicit, operator-verified Pod egress CIDRs and API endpoints in the
  deployment inventory; do not guess a cluster CIDR or rely on host DNS alone.

The existing owner root records the HTTPS registry and BuildKit mTLS
references in `config/buildkit/endpoint.json`; `owner.json` carries the
disposable marker and expiry. Read the endpoint metadata without printing PEM
contents, then revalidate the owner marker and expiry before each run. Its
registry is HTTPS with owner-managed CA trust. BuildKit is a separate TCP mTLS
endpoint with a server name, CA, client certificate, and client key. The CA
and key files live below the private owner root's `config/buildkit/tls/`.
Provide those files through the owner-controlled secret mechanism and the Build
Worker configuration. Configure the BuildKit daemon's registry CA and registry
auth separately from its inbound mTLS listener. The example in the fixed
BuildKit runner guide uses HTTPS; use the current owner's HTTPS endpoint and
CA for this environment, and do not set the insecure-loopback option. Set
`OWNER_REGISTRY_CA_FILE` to the owner's certificate-only CA PEM and pass it
with `--ca-file` when running the fixed verifier. For an explicitly owned
anonymous HTTPS registry on `127.0.0.1`, also set
`PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH=1`; this restricts publication
to the configured candidate/composition repositories and keeps TLS enabled. The verifier validates an
absolute, current-UID-owned, regular CA file bounded to 256 KiB, rejects
symlinks and private-key PEM blocks, and passes only that explicit path to its
fixed runner processes as `NODE_EXTRA_CA_CERTS`. Ambient
`NODE_EXTRA_CA_CERTS` and `NODE_OPTIONS` remain stripped. Keep CA and PEM
contents, Docker auth config, registry credentials, and private keys out of
source, rendered evidence, and logs. A loopback BuildKit/registry endpoint is
reachable only from a worker in its owned host network namespace; it cannot
be used from an unrelated Pod network.

The production OCI client uses the runtime's `globalThis.fetch` trust and has
no per-registry CA-file field. The fixed runner's explicit CA option supplies
trust to the Node process that exercises this path. Any separately deployed
long-lived service that reads the private registry also needs the owner CA in
its own reviewed runtime trust configuration. Keep TLS verification enabled.

## 4. Build and deploy the disposable services

Create an owner-private deployment inventory from
`infrastructure/test/disposable-inventory.json`, then fill every required
field from live owned resources: exact HTTPS origins and service URL, cluster
ID/context, instance suffix, BuildKit endpoint/repositories and allowed
clients, output/composition repositories, target platform, builder key pair,
resource and cache-retention policies, ACME contact where used, and immutable
service-image references. Keep GitHub App and service secret values in the
owner's secret manager; the inventory stores locators, never secret values.

Build the service images from a clean Praetorium checkout using
`infrastructure/docker/service-runtime.Dockerfile` for Provisioner,
`apps/instance-access/Dockerfile` for Instance Access, and
`infrastructure/docker/build-worker.Dockerfile` for Build Worker. Instance Access
pins its Node image in both stages; the generic Provisioner and Build Worker
recipes require repository-qualified digest inputs. For Build Worker, also supply a
digest-pinned BuildKit client image plus the exact `buildWorker.buildctlPath`.
The builder image and application images must be pushed to the owned HTTPS
registry and then recorded by immutable digest. Do not put Git credentials,
author content, App keys, or repository files in the image context. The
service-runtime and Build Worker ignore rules exclude secret/credential paths
and key files. Instance Access excludes Git/worktrees, dependencies, build
outputs and environment files, but does not generally exclude every secret
filename. Build only from a verified clean source checkout and keep all owner
credentials outside it; inspect the actual build context before pushing.

Use the exact source cut recorded for each image. The following are the actual
BuildKit recipe and immutable base arguments used in this campaign. Set the
owner paths/endpoints from the private inventory; registry CA trust must also
be configured in the BuildKit daemon. `SOURCE` must be a clean checkout at the
chosen recorded commit, and evidence must stay outside that checkout.

```bash
SOURCE=/path/to/clean/praetorium
SOURCE_SHA='<recorded-service-source-commit>'
BUILDCTL=/path/to/owned/buildctl
BUILDKIT_ADDR='tcp://<owned-host>:<port>'
BUILDKIT_TLS_SERVER_NAME='<owned-buildkit-server-name>'
TLS_DIR=/private/owner/buildkit/tls
REGISTRY='<owned-registry-host:port>'
IMAGE_EVIDENCE=/private/owner/evidence/images
NODE_IMAGE=docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
BUILDKIT_CLIENT_IMAGE=docker.io/moby/buildkit@sha256:c1d0a1bc930a427f99f72220d1b263d6986d4592b21507fbc7f8bf7ecdaed004

test "$(git -C "$SOURCE" rev-parse HEAD)" = "$SOURCE_SHA"
test -z "$(git -C "$SOURCE" status --porcelain)"
mkdir -p "$IMAGE_EVIDENCE"

build_platform_image() {
  "$BUILDCTL" --addr "$BUILDKIT_ADDR" \
    --tlsservername "$BUILDKIT_TLS_SERVER_NAME" \
    --tlscacert "$TLS_DIR/ca.pem" --tlscert "$TLS_DIR/client-cert.pem" \
    --tlskey "$TLS_DIR/client-key.pem" \
    build --progress=plain --frontend=dockerfile.v0 \
    --local context="$SOURCE" --local dockerfile="$SOURCE" \
    --opt platform=linux/amd64 "$@"
}

build_platform_image \
  --opt filename=infrastructure/docker/service-runtime.Dockerfile \
  --opt "build-arg:NODE_BUILD_IMAGE=$NODE_IMAGE" \
  --opt "build-arg:NODE_RUNTIME_IMAGE=$NODE_IMAGE" \
  --opt build-arg:SERVICE_PACKAGE=@praetorium/provisioner \
  --output "type=image,name=$REGISTRY/praetorium/platform-provisioner:source-$SOURCE_SHA,push=true" \
  --metadata-file "$IMAGE_EVIDENCE/provisioner-$SOURCE_SHA.json"

build_platform_image --opt filename=apps/instance-access/Dockerfile \
  --output "type=image,name=$REGISTRY/praetorium/platform-instance-access:source-$SOURCE_SHA,push=true" \
  --metadata-file "$IMAGE_EVIDENCE/instance-access-$SOURCE_SHA.json"

build_platform_image \
  --opt filename=infrastructure/docker/build-worker.Dockerfile \
  --opt "build-arg:NODE_BUILD_IMAGE=$NODE_IMAGE" \
  --opt "build-arg:NODE_RUNTIME_IMAGE=$NODE_IMAGE" \
  --opt "build-arg:BUILDKIT_CLIENT_IMAGE=$BUILDKIT_CLIENT_IMAGE" \
  --opt build-arg:BUILDKIT_CLIENT_BUILDCTL_PATH=/usr/bin/buildctl \
  --opt build-arg:PRAETORIUM_BUILDKIT_BUILDCTL_PATH=/usr/local/bin/buildctl \
  --opt build-arg:SERVICE_PACKAGE=@praetorium/build-worker \
  --output "type=image,name=$REGISTRY/praetorium/platform-build-worker:source-$SOURCE_SHA,push=true" \
  --metadata-file "$IMAGE_EVIDENCE/build-worker-$SOURCE_SHA.json"

curl --fail --silent --show-error --head --cacert "$TLS_DIR/ca.pem" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://$REGISTRY/v2/praetorium/platform-provisioner/manifests/source-$SOURCE_SHA"
```

Compare `Docker-Content-Digest` with `containerimage.digest` from the matching
metadata file, then verify manifest/config/all-layer bytes through the product
registry verifier. A HEAD response alone is not that content verification.
Record newly measured digests rather than assuming a rebuild reproduces prior
bytes. For the existing artifacts, deploy the exact digest references in the
artifact JSON. Producer Runtime Base/Build Kit commands are in Scriptorium's
[deployment guide](https://github.com/yohn-jp/scriptorium/blob/main/docs/HOSTED-DEPLOYMENT.md).

Run the existing infra plan, preflight and render against the private
disposable inventory. Then provision the referenced Secrets out of band before
applying. The static manifests expect:

- In `praetorium-system`, the Provisioner credential (`credential` key), the
  Instance Access service token, and the application image-pull Secret.
- In `praetorium-build`, the Build Worker Control Plane token, Ed25519 private
  key, BuildKit client CA/certificate/key, BuildKit Docker registry config,
  separate registry-read JSON credential, and application image-pull Secret.
- In `praetorium-observability`, the application image-pull Secret.

Use `Opaque` type for service and Build Worker inputs, `kubernetes.io/tls` for
the BuildKit client material, and `kubernetes.io/dockerconfigjson` for the
image-pull secret. The BuildKit Docker config and the Node Build Worker's
`{"username":"…","password":"…"}` pull credential are different inputs.
The Control Plane's optional `REGISTRY_PULL_CREDENTIAL` is another distinct
credential. The T12 apply preflight checks Secret types and key names, not
secret contents.

Reuse the existing owner-marked Kind cluster where available. Do not call
`create` again for an existing environment; validate its owner marker, exact
context, cluster ID, API endpoint, live Node labels and remaining lifetime.
For an owner-approved new disposable cluster only, the existing product commands are:

```sh
node scripts/deploy-infrastructure.mjs plan --inventory "$DEPLOYMENT_INVENTORY"
node scripts/deploy-infrastructure.mjs preflight --inventory "$DEPLOYMENT_INVENTORY"
node scripts/deploy-infrastructure.mjs render --inventory "$DEPLOYMENT_INVENTORY"
node scripts/deploy-infrastructure.mjs create --inventory "$DEPLOYMENT_INVENTORY" --confirm "$KIND_CLUSTER_NAME"
node scripts/deploy-infrastructure.mjs apply --inventory "$DEPLOYMENT_INVENTORY" --confirm "$KIND_CLUSTER_NAME"
```

`apply` uses only the inventory's generated owner-only kubeconfig and context;
never substitute the caller's current context. It applies the static
disposable Kustomize bundle, validates admission policies, checks the fixed
Instance Access, Provisioner, Build Worker and Prometheus Deployments, and does
not create tenant instances. Preserve the inventory, rendered bundle, image
digests, owner marker, and application results for the acceptance record.

### Workers and D1

Control Plane owns the `praetorium-platform` D1 database and all five migrations
in order:

1. `0001_repository_platform.sql`
2. `0002_stable_release_rollouts.sql`
3. `0003_staged_configurations.sql`
4. `0004_runtime_git_credentials.sql`
5. `0005_runtime_health_observations.sql`

Gateway has no D1 database. Its `USER_AUTH_STATE` and `EPHEMERAL_CODES`
Durable Objects and `GATEWAY_KV` namespace are separate bindings. The existing
`node scripts/deploy-workers.mjs plan` and `preflight` commands report the
required bindings, secrets, variables and migration set. `apply-local` applies
only the five D1 migrations to local Wrangler state under
`/tmp/praetorium-t12-workers/<cluster-name>` and requires
`cloudflare.mode=local`:

```sh
node scripts/deploy-workers.mjs plan --inventory "$DEPLOYMENT_INVENTORY"
node scripts/deploy-workers.mjs preflight --inventory "$DEPLOYMENT_INVENTORY"
node scripts/deploy-workers.mjs apply-local \
  --inventory "$DEPLOYMENT_INVENTORY" --confirm "$KIND_CLUSTER_NAME"
```

This script does not deploy Workers, provision remote D1/KV/DOs, or set
secrets. For an owned disposable Cloudflare environment, use private
owner-generated Wrangler configs bound to its disposable D1/KV/DOs, verify
those resource IDs, set the distinct Worker secrets through the owner's secret
manager, then use the standard Wrangler commands with those configs:

```sh
corepack pnpm@11.18.0 exec wrangler d1 migrations apply praetorium-platform \
  --remote --config "$CONTROL_PLANE_WRANGLER_CONFIG"
corepack pnpm@11.18.0 exec wrangler deploy --config "$CONTROL_PLANE_WRANGLER_CONFIG"
corepack pnpm@11.18.0 exec wrangler deploy --config "$GATEWAY_WRANGLER_CONFIG"
```

The Control Plane config must name the exact disposable D1 database and
`apps/control-plane/migrations`; the Gateway config must bind the disposable KV
namespace, its two Durable Objects, and the Control Plane service. The tracked
Worker templates and `wrangler.toml` files contain placeholder/local
identifiers and must not be sent to a remote account unchanged. `deploy` also
applies the declared Gateway Durable Object class migration. Do not use
production credentials or account bindings for this campaign.

The Gateway Worker needs its matching public active key record in its KV before
serving. Verify all three public JWKS endpoints after deployment:

```text
https://<gateway-origin>/.well-known/jwks.json
https://<control-plane-origin>/.well-known/control-jwks.json
https://<control-plane-origin>/.well-known/runtime-identity-jwks.json
```

Check that each endpoint returns only the intended public key, with the exact
key ID and issuer binding. Never expose private JWK fields. Then verify the
Gateway/Control Plane service bindings in both directions and their exact
origin configuration before browser login.

## 5. Configure runtime services and start the product path

The static `platform-services.yaml` deploys the Node Instance Access adapter
and Provisioner. Instance Access needs `GATEWAY_ORIGIN`,
`INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX`, `GATEWAY_URL`, and the shared
`INSTANCE_ACCESS_SERVICE_AUTH_TOKEN`. The normal route is HTTPS/service
network; plain HTTP `GATEWAY_URL` is allowed only in the disposable test
overlay. The Gateway uses the same Instance Access service-auth secret.

Provisioner is configured by the generated `praetorium-provisioner-config`
ConfigMap: Control Plane HTTPS URL, exact worker and cluster IDs, namespace
prefix, configured ingress and Instance Access service names, resource caps,
and mounted `PROVISIONER_CREDENTIAL_PATH`. The `PROVISIONER_AUTH_TOKEN` is
distinct from Gateway, Build Worker and release-operator credentials. Its
Control Plane issuer and audience fields must match the signed runtime
assignment. Wait for real Provisioner readiness after the producer assignment,
grant-probe, status and quiesce paths are integrated; a process health response
alone does not prove runtime operations are enabled.

Build Worker reads `PRAETORIUM_BUILD_*` and `PRAETORIUM_BUILDKIT_*` values from
its generated ConfigMap and private mounted files. Its service token must match
the Control Plane build service token; its signer key ID/public key must match
the Control Plane build policy; its BuildKit mTLS CA, server name, certificate
and key must belong to the selected owned endpoint. Its output and composition
repositories must exactly match the admission policy. The Build Worker init
container copies the required inputs to private runtime files; do not bake
credentials into the image.

Only after those checks, use the Praetorium administration UI through Gateway
and a real GitHub App login. Select the authorized test repository, configure
Core and the two legal non-preset compositions, build and enter the instance.
Use the same instance ID and HTTPS origin for redeploy, composition change,
same-digest restart, stop/wake, and rollback cases. Save after each operation
only through the real Checkpoint/GitHub flow. Verify actual remote commits and
browser state; don't infer a successful save from local editor state.

## 6. Run the fixed product acceptance suite

Build the workspace at the integrated Praetorium SHA, and ensure producer
ledger fields, policy and owner-side config refer to the final immutable
producer release. The fixed verifier runs all seven runners in sequence and
gives each a clean environment. It must run with one complete owner inventory;
do not invoke a subset as a full pass.

```sh
node scripts/verify-integration.mjs --environment "$ACCEPTANCE_INVENTORY" \
  --ca-file "$OWNER_REGISTRY_CA_FILE" --plan
node scripts/verify-integration.mjs --environment "$ACCEPTANCE_INVENTORY" \
  --ca-file "$OWNER_REGISTRY_CA_FILE" \
  > "$OWNER_EVIDENCE_DIR/acceptance-report.json"
```

The second command's exit status is part of the evidence: `0` means every
category returned `VERIFIED`; `2` means blocked/failed or invalid inventory;
`3` means the run did not verify all categories. Preserve stdout as a private
owner evidence file and record the exact command, integrated Praetorium SHA,
Scriptorium SHA/tree, producer artifact digests, owned environment references,
timestamps, category outcomes, and independent review. Do not preserve
credentials, session cookies, GitHub tokens, App PEM, BuildKit PEM, manuscript
content, raw registry auth, or raw request logs in the report.

The fixed categories exercise the following actual paths:

| Runner                 | Product proof required                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers-d1-do`        | Actual bundled Control Plane Worker, all five current local D1 migrations, Durable Object repository coordination and persisted authorization paths.                                                                                                                                                                    |
| `github-access`        | Real Gateway sessions for writer and read-only users, user/App permission intersection, repository scoping, App-token refresh, clone/fetch/push, and user-authorized publication receipt.                                                                                                                               |
| `buildkit-registry`    | Core and two legal non-preset builds through the resolver, Build Worker and mTLS BuildKit; OCI dependency/manifest inspection, cache reuse, and stale/failed result rejection. This is one-shot for a Control Plane/D1 state because build keys are unique; a retry requires a fresh owner-declared state and instance. |
| `kubernetes-isolation` | Owner-verified Kind, installed admission policies, actual Pod image IDs, capacity, ingress, and allowed/denied packets through the active CNI.                                                                                                                                                                          |
| `browser-entry`        | Chromium GitHub App login, repository selection, handoff, stopped-origin wake, editing, Checkpoint, GitHub save, re-entry, composition change and same-origin redeploy.                                                                                                                                                 |
| `producer-recovery`    | Live Scriptorium status/quiesce, safe/unsafe stop decisions, confirmed-remote re-clone, preserved checkpoint/conflict behavior, same-origin runtime recovery and browser-journal reconciliation.                                                                                                                        |
| `stable-rollout`       | Stable and pinned selection, failed canary preservation, same-digest epoch change, composition update, compatibility-evidence rollback, and serving-instance retention.                                                                                                                                                 |

Treat any `BLOCKED`, `NOT_CHECKED`, `FAILED`, skipped live case, or absent
artifact binding as a non-pass. Unit tests, plan output, image existence,
registry reachability, substrate scratch builds, and previous historical runs
do not fill a current fixed-runner result. Update `docs/verification/ACCEPTANCE`
and `docs/migration/PRODUCER-STATUS.json` only with evidence from this exact
source and owner environment.

## 7. Remote metadata recovery

The local Restic restore test is not off-host acceptance. Use the existing
[recovery CLI](../recovery/README.md) against an explicitly owned disposable
remote D1 and genuine off-host Restic repository. Load both
`RESTIC_REPOSITORY` and the matching `PRAETORIUM_OFFHOST_RESTIC_REPOSITORY` from
the protected owner configuration, alongside the Restic password and recovery
key. S3 custom endpoints belong in the actual repository URI. The validator
rejects exposed loopback/local targets, missing S3 buckets, and conflicting
`RESTIC_REPOSITORY_FILE`; configuration validation alone does not prove the
remote storage operation. Run the actual remote export, encrypted backup,
verified retrieval and inert restore before closing T13.

## 8. Cleanup and preservation

Do not delete or replace an instance while Scriptorium reports active work,
unpublished checkpoints, pending Git operations, or an unknown remote result.
Use producer quiesce and writer-census evidence before removal. A lease timeout
is not writer absence. Keep GitHub as the source of truth and preserve the
original stable instance origin so the browser can restore its journal after a
safe restart.

After all operations are confirmed, stop only the test-owned instances and
remove only resources whose inventory owner, UID, and disposable marker match
this run. Preserve test repositories, relevant Git commits, final acceptance
report, image digests, configuration checksums, cleanup report, and review
record until the campaign evidence is integrated. Never delete legacy or
production data as part of this procedure.
