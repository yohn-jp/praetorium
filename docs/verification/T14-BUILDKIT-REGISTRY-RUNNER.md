# T14 BuildKit and registry runner

`tests/integration/buildkit-registry.test.mjs` is the fixed `buildkit-registry`
runner used by `scripts/verify-integration.mjs`. It requires an owner-managed
HTTPS Control Plane, an admitted Scriptorium release, a dedicated stopped test
instance with no current or desired runtime revision, and an exclusive build
queue. The runner asks the production
configuration resolver for Core and two legal single-addon selections, submits
them through the production build queue and Build Worker, and checks the
resulting digest-pinned OCI image and composition receipt. It also verifies
same-key artifact reuse and rejects a signed result from an expired attempt and
a late failure report. The production candidate verifier checks the immutable
image closure and runs the composition's declared smoke before the worker signs
the candidate; the runner records the accepted build status and declared smoke
contract as evidence of that path.

The standard inventory declares ownership of the BuildKit and registry
substrate. The runner reads a private owner configuration from
`<absolute-inventory-path>.buildkit-registry.json`. Create it with mode `0600`
and the current user as owner. The exact schema is:

```json
{
  "schemaVersion": 1,
  "inventoryPath": "/absolute/path/to/acceptance-inventory.json",
  "ownerIdentity": "the inventory owner.identity value",
  "environment": {
    "resourceReference": "the inventory buildkit-registry reference",
    "expiresAt": "the inventory environment.expiresAt value",
    "disposable": true,
    "production": false,
    "exclusiveBuildQueue": true
  },
  "controlPlane": {
    "origin": "https://owned-control-plane.example",
    "gatewayTokenFile": "/absolute/path/to/private-gateway-token",
    "repository": {
      "id": 123456,
      "installationId": 1234567,
      "owner": "test-owner",
      "name": "test-repository",
      "authorizationRevision": 1,
      "instanceId": "the-existing-stopped-test-instance"
    },
    "actorId": "the-authorized-test-actor"
  },
  "releaseId": "the-admitted-scriptorium-release",
  "buildWorkerEnvironment": {
    "PRAETORIUM_BUILD_WORKER_ID": "the-dedicated-worker-id",
    "PRAETORIUM_CONTROL_PLANE_URL": "https://owned-control-plane.example",
    "PRAETORIUM_BUILD_SERVICE_TOKEN_FILE": "/absolute/path/to/private-build-service-token",
    "PRAETORIUM_BUILD_SIGNING_KEY_FILE": "/absolute/path/to/private-builder-signing-key",
    "PRAETORIUM_BUILD_SIGNING_KEY_ID": "the-admitted-builder-key-id",
    "PRAETORIUM_BUILD_REGISTRY_URL": "https://127.0.0.1:35009",
    "PRAETORIUM_BUILD_COMPOSITION_REPOSITORY": "praetorium/compositions",
    "PRAETORIUM_BUILD_MAX_IMAGE_LAYER_BYTES": "1073741824",
    "PRAETORIUM_BUILD_MAX_IMAGE_VERIFICATION_MS": "60000",
    "PRAETORIUM_BUILD_MAX_REGISTRY_REQUEST_MS": "15000",
    "PRAETORIUM_BUILDKIT_ADDRESS": "tcp://127.0.0.1:1234",
    "PRAETORIUM_BUILDKIT_TLS_SERVER_NAME": "buildkit.test",
    "PRAETORIUM_BUILDKIT_TLS_CA_FILE": "/absolute/path/to/buildkit-ca.pem",
    "PRAETORIUM_BUILDKIT_TLS_CERT_FILE": "/absolute/path/to/buildkit-client.pem",
    "PRAETORIUM_BUILDKIT_TLS_KEY_FILE": "/absolute/path/to/private-buildkit-client-key.pem",
    "PRAETORIUM_BUILDKIT_BUILDCTL_PATH": "/absolute/path/to/buildctl",
    "PRAETORIUM_BUILDKIT_FRONTEND_REPOSITORY": "127.0.0.1:35009/scriptorium/build-kit",
    "PRAETORIUM_BUILDKIT_OUTPUT_REPOSITORY": "127.0.0.1:35009/praetorium/candidates",
    "PRAETORIUM_BUILDKIT_DOCKER_CONFIG_DIRECTORY": "/absolute/path/to/private-docker-config",
    "PRAETORIUM_BUILDKIT_TEMPORARY_DIRECTORY": "/absolute/path/to/private-buildkit-tmp",
    "PRAETORIUM_BUILDKIT_SAFE_PATH": "/usr/bin:/bin"
  },
  "evidencePath": "/absolute/path/to/acceptance-inventory.json.buildkit-registry-evidence.json"
}
```

Optional worker tuning keys may be supplied using the `PRAETORIUM_BUILD_*` and
`PRAETORIUM_BUILDKIT_*` keys accepted by `readBuildWorkerConfig`; the runner
rejects other keys. The TLS endpoint and client material must belong to the
owned disposable BuildKit environment. The runner does not treat a generic
BuildKit socket check or fixture image as producer acceptance.

The registry CA is separate from BuildKit's inbound mTLS client certificate
and key. Pass its absolute PEM path explicitly to the fixed verifier. The
verifier requires a current-UID-owned regular file no larger than 256 KiB,
rejects symlinks and private-key PEM blocks, and passes that selected path to
each fixed runner as `NODE_EXTRA_CA_CERTS`. It does not inherit ambient
`NODE_EXTRA_CA_CERTS` or `NODE_OPTIONS`.

Build the workspace before running the fixed suite so workspace package entry
points exist, then run the verifier with the owner's inventory:

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
corepack pnpm@11.18.0 build
node scripts/verify-integration.mjs --environment /absolute/path/to/acceptance-inventory.json \
  --ca-file /absolute/path/to/owner-registry-ca.pem
```

For endpoints already trusted by Node, omit `--ca-file`. For the owned private
registry and Control Plane, pass the owner's certificate-only CA file. Leave
TLS verification enabled and omit
`PRAETORIUM_BUILD_ALLOW_INSECURE_LOOPBACK_REGISTRY`.

For an explicitly owned anonymous HTTPS registry on `127.0.0.1`, set
`PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH=1` in the worker environment.
This permits publication only to its configured candidate and composition
repositories. It keeps TLS verification enabled and does not send a configured
pull credential as a publish credential. Authenticated registries use the
normal separate registry credentials instead.

The runner writes private evidence to the configured `evidencePath` only after
all three builds, cache reuse and stale-report assertions pass. It never writes
credentials, BuildKit logs or source content into the evidence file.

This runner is one-shot for a given disposable Control Plane/D1 state. The
build table keys artifacts globally by immutable `buildKey`; the runner also
requires a fresh instance and uses an exclusive evidence-file create. It leaves
the instance stopped on the last selected addon and preserves its admitted
build records. After a failed or completed attempt, rerun only with a newly
prepared owner-declared disposable Control Plane/D1 state, fresh stopped test
instance, and new inventory/config/evidence paths. The runner does not reset or
delete database rows. Reuse the owned BuildKit/registry substrate if it remains
valid, and re-admit the same immutable producer release into the fresh test
Control Plane state.
