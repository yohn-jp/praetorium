# Runtime credential retirement: partial Worker evidence

This local integration evidence passed on 2026-10-17 against the committed
production source tree recorded by the test at runtime. The test requires that
tree to be clean except for its own test and this evidence note, and reports the
exact `git rev-parse HEAD` in its Node test diagnostic.

The probe builds the actual Control Plane Worker entry with Wrangler
`deploy --dry-run`, runs it in Miniflare with its actual `RepositoryCoordinator`
Durable Object and an owned temporary D1 database, and applies migrations 0001
through 0004. It exercises the mounted runtime-credential and Provisioner
checkpoint routes, D1 credential store, and actual Gateway
`RuntimeCredentialRegistry`, AES-GCM `TokenVault`, GitHub REST client, and
installation-token revoker. The local Miniflare Gateway service binding bridges
to the actual registry helper; it does not run the Gateway Worker HTTP entry.

For the retirement barrier case, the test inserts a synthetic encrypted active
credential and a synthetic running operation, then submits a schema-shaped
`old-writer-absent` proof with `remainingWriters: 0` through the actual
Provisioner checkpoint route. These are test inputs only: there is no actual
runtime writer, runtime lease, artifact, or Kubernetes provider census. A local
HTTP server is the only injected GitHub transport and supplies synthetic
responses. With GitHub returning 401, the actual route persists the checkpoint
and moves the known credential to `revocation_pending`, while returning 503.
After the local transport returns 204, the actual Gateway registry invokes the
Control Plane acknowledgement route, D1 marks the credential `revoked`, and a
retry of the actual checkpoint route succeeds. A separate synthetic proof
with `retiredRuntimeEpoch: null` succeeds without calling the Gateway binding
or changing a seeded credential from `active`.

The other cases verify that registration without an active runtime binding
stays pending; 401, timeout, and network failure leave revocation pending; a
later 204 acknowledgement revokes it; and raw synthetic tokens do not appear in
the stored D1 credential rows or Gateway-to-Control-Plane request bodies. The
probe also inserts one synthetic `released` reservation only to satisfy the
pending-query route's historical-reservation check. It does not represent a
current runtime lease.

Reproduce with the repository's pinned dependencies and relevant Worker builds:

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
corepack pnpm@11.18.0 exec turbo run build --filter=@praetorium/control-plane --filter=@praetorium/gateway --filter=@praetorium/github
node --check tests/integration/runtime-credentials-worker.partial.test.mjs
node --test tests/integration/runtime-credentials-worker.partial.test.mjs
```

The fresh focused run passed one Node integration test. Wrangler bundled the
committed Control Plane Worker, and Miniflare exercised the four real D1
migrations and Worker routes. The test disposes the Worker, local HTTP server,
bundle directory, and temporary D1/DO storage after execution.
The complete `corepack pnpm@11.18.0 check` also passed on this production source
cut, including build, lint, typecheck, package tests, boundary checks, and
contract-schema drift checks.

This is partial local execution evidence for encrypted credential persistence,
fail-closed revocation, and the Control Plane checkpoint barrier for a
synthetic zero-census proof. It is not evidence of a real writer-absence proof,
live GitHub App or GitHub API behavior, successful credential issuance, the
Gateway Worker HTTP route, artifact execution, producer acceptance, a real
Kubernetes environment, or a T14 worker-category/platform acceptance gate. No
external credentials or services are used.
