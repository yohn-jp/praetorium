# T14 partial Gateway Worker source execution

Status: **PARTIAL_SOURCE_EXECUTION**. The fixed `browser-entry` category remains **BLOCKED** / `NOT_CHECKED`; this probe does not satisfy or change that gate.

## Source cut and command

The probe bundled `apps/gateway/src/worker.ts` from Praetorium commit `6eb72062cdbd6e655b74dc173e8de13d31020400` and ran it in Miniflare `4.20260730.0` with ephemeral local KV and the actual `UserAuthStateDurableObject` and `EphemeralCodeDurableObject` classes. Chromium `156.0.8078.4` exercised the loopback HTTPS Worker. The package outputs used by the bundle were built from that same detached source worktree. The committed Gateway and Instance Access subtrees at main HEAD `9d3677c1fad164c9d461516d78483d950827ff45` matched this source cut; main had unrelated uncommitted Control Plane edits during the comparison.

From the isolated `worker/t14` worktree, the command was:

```sh
PRAETORIUM_GATEWAY_SOURCE_ROOT=/tmp/praetorium-source-6eb \
PRAETORIUM_T14_BROWSER_ENVIRONMENT_PATH=/tmp/praetorium-browser-env.json \
PATH=/tmp/praetorium-bin:$PATH \
node --test tests/e2e/gateway-worker-security.partial.test.mjs
```

Result: **1 passed, 0 failed**. The test bundles the committed Worker source and asserts the source HEAD and Gateway diff remain fixed while it runs.

## Observed behavior

- An attacker-controlled request Host on repository and instance entry redirects to the configured Gateway origin, and the credential-bearing incoming query is omitted from both the login redirect and request logs.
- The generated GitHub OAuth start URL uses the configured callback origin and issues a `Secure`, `HttpOnly`, `SameSite=Lax`, host-only login nonce cookie.
- A locally seeded session is resolved through the real Gateway DO and KV path in an actual browser; duplicate session, nonce, and CSRF cookies fail closed in direct requests to the same Worker.
- The unauthenticated session endpoint returns 401, and JWKS exposes only the public signing key.

The Control Plane service binding deliberately returned a fail-closed response for unexpected calls. The browser blocked external navigation, and the test made no GitHub App/OAuth success claim. Session setup wrote synthetic local state directly to the actual local DO/KV; duplicate-cookie cases use direct Worker requests because Chromium cannot naturally emit duplicate `__Host-` cookies.

This is local source execution only. It does not exercise Instance Access, a stable owned origin, successful GitHub App login, a producer artifact, re-entry/recovery, or a deployed environment. The six other T14 categories and the fixed `browser-entry` category remain governed by the owned inventory and their required real integration resources.
