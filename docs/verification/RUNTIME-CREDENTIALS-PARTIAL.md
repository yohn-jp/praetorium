# Runtime credential retirement: partial Worker evidence

The local integration probe passed against committed source cut
`094719bebe7b05ed02fedcbd55762c29bebce514` on 2026-10-17. The test pins the
source tree to that commit, excluding only this evidence file and its companion
test, so a rerun fails if production source has drifted.

The probe runs the actual Control Plane Worker bundle produced by Wrangler
`deploy --dry-run`, with its real `RepositoryCoordinator` Durable Object and an
owned temporary Miniflare D1 database. It applies migrations 0001 through 0004,
uses the mounted credential routes and actual D1 credential store, and imports
the committed Gateway `RuntimeCredentialRegistry`, AES-GCM `TokenVault`, GitHub
REST client, and installation-token revoker. The probe also verifies that
unauthenticated and incorrectly authenticated Control Plane requests receive
401 responses.

With no active runtime binding, a synthetic credential registration is
recorded as pending. A local HTTP server is the only injected transport: the
actual GitHub client remains pinned to `https://api.github.com`, and the
transport maps its request to localhost to return synthetic 204, 401, timeout,
and network-failure outcomes. A 401, timeout, and network failure all leave the
credential pending. A later 204 flows through the actual Control Plane
acknowledgement route and changes the D1 row to revoked. The test checks that
the D1 envelope and every Gateway-to-Control-Plane request body omit the raw
synthetic bearer tokens.

The probe inserts one synthetic `released` reservation solely because the
actual pending-query route requires a durable historical reservation for the
repository epoch. The instance remains stopped and absent, has no observed
runtime or artifact digest, and the actual runtime-binding route returns 404.
This row is not a current runtime lease and supplies no writer-absence proof.
The runtime identity values passed directly to the Gateway registry are also
synthetic; no runtime identity signature or active binding is asserted.

Reproduce from this source cut after installing workspace dependencies with
`corepack pnpm@11.18.0 install --frozen-lockfile`:

```sh
corepack pnpm@11.18.0 exec turbo run build --filter=@praetorium/gateway --filter=@praetorium/github
node --check tests/integration/runtime-credentials-worker.partial.test.mjs
node --test tests/integration/runtime-credentials-worker.partial.test.mjs
```

The fresh run passed one Node integration test. Wrangler bundled the committed
Control Plane entry; Miniflare applied all four migrations and exercised the
actual D1 routes and store. The test disposes the Worker, HTTP server, bundle,
and temporary D1/DO storage on completion.

This is narrow local execution evidence for encrypted registration, fail-closed
revocation, and durable acknowledgement. It does not establish a live GitHub
App or real GitHub API result, successful token issuance, the Gateway HTTP
broker or its authentication path, a current runtime lease, writer absence,
artifact execution, producer acceptance, a real Kubernetes environment, or a
T14 worker-category / platform acceptance gate. No external credential or
service is used.
