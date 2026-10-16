# T14 partial Gateway Worker source execution

Status: **PARTIAL_SOURCE_EXECUTION**. The fixed `browser-entry` category remains **BLOCKED** / `NOT_CHECKED`; this probe does not satisfy or change that gate.

## Source cut and command

The probe bundled `apps/gateway/src/worker.ts` from Praetorium commit `f82227a9b35702e33a28bc25f62911f86a351767` and ran it in Miniflare `4.20260730.0` with ephemeral local KV and the actual `UserAuthStateDurableObject` and `EphemeralCodeDurableObject` classes. Chromium `156.0.8078.4` exercised the loopback HTTPS Worker. The committed `apps/gateway` and `apps/instance-access` trees at current main `d029989dbc6b78024bd401ed37e07e63336c1f6c` are byte-identical to the tested source cut.

From the isolated `worker/t14` harness, the test used `tests/e2e/gateway-worker-security.partial.test.mjs` with `PRAETORIUM_GATEWAY_SOURCE_ROOT` set to the f82227a source checkout and the cached browser environment in `/tmp/praetorium-browser-env.json`.

Result: **1 passed, 0 failed**. The measured test duration was 6094.448 ms; the full Node test process took 6819.065 ms. The test asserts the source HEAD and Gateway diff remain fixed while it runs. The captured output is in `/tmp/praetorium-campaign-final-browser.log`.

## Observed behavior

- An attacker-controlled request Host on repository and instance entry redirects to the configured Gateway origin, and the credential-bearing incoming query is omitted from the login redirect and request logs.
- The generated GitHub OAuth start URL uses the configured callback origin and issues a `Secure`, `HttpOnly`, `SameSite=Lax`, host-only login nonce cookie.
- A locally seeded session resolves through the real Gateway DO and KV path in an actual browser; duplicate session, nonce, and CSRF cookies fail closed in direct requests to the same Worker.
- The unauthenticated session endpoint returns 401, and JWKS exposes only the public signing key.

The Control Plane service binding deliberately returned a fail-closed response for unexpected calls. The browser blocked external navigation, and the test made no GitHub App/OAuth success claim. Session setup wrote synthetic local state directly to the actual local DO/KV; duplicate-cookie cases use direct Worker requests because Chromium cannot naturally emit duplicate `__Host-` cookies.

This is local source execution only. It does not exercise Instance Access, a stable owned origin, successful GitHub App login, a producer artifact, re-entry/recovery, or a deployed environment. All other fixed T14 categories remain governed by the owned inventory and their required real integration resources.
