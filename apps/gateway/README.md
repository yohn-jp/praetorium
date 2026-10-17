# Gateway

Gateway is the browser and identity boundary for repository instances. It
authenticates users with the configured GitHub App, encrypts the returned user
token bundle, resolves one durable repository binding through Control Plane,
and issues short lived access grants only after current GitHub access has been
rechecked. Instance application traffic stays at its stable instance origin;
Gateway never proxies application request bodies.

The Worker uses Hono and requires its Durable Object, KV and Control Plane
service bindings plus all deployment secrets before routing a request. Its
Durable Objects hold sessions, GitHub token bundles, MCP credentials, OAuth
attempts and one use handoff/refresh records. KV contains the digest lookup
indexes, rate limits and public signing key registry. No in-memory authority
or default identity provider is used.

## Public routes

- `GET /auth/github/start` and `GET /auth/github/callback` implement the
  browser bound OAuth/PKCE flow. The start route sets a short lived
  `Secure; HttpOnly; SameSite=Lax` nonce cookie; the callback clears it on all
  outcomes.
- `GET /api/session`, `POST /auth/logout` and `POST /auth/logout-all` expose
  the session and logout lifecycle. Browser mutations require the current
  session CSRF token and exact Gateway origin.
- `GET /` and `GET /repositories/:repositoryId` render the repository list and
  detail through the SSR portal. The portal reads the current GitHub access
  provider and does not expose a separate instance-ownership API.
- `POST /repositories/:repositoryId/actions` is the SSR portal command
  entry. `POST /api/repositories/:repositoryId/mutation-authorizations`
  issues a 60 second maximum signed publisher receipt for metadata only; its
  body contains an operation ID and SHA-256 payload digest, never source or
  manuscript content.
- `GET /entry/:instanceId` revalidates the current user and binding, presents
  configuration requirements when no approved artifact is selected, and
  otherwise requests the existing instance to run. It waits on a real
  operation or returns a one use form POST handoff after observing the current
  generation and runtime epoch ready.
- `POST /api/credentials`, `GET /api/credentials`,
  `POST /api/credentials/:id/revoke`, `POST /api/credentials/revoke-all`, and
  `POST /api/token` implement bounded repository scoped MCP credentials and
  access token exchange.
- `GET /.well-known/jwks.json` publishes only the active public signing key.
- Authenticated `POST /internal/instance-access/handoff`, `/refresh`, and
  `/revoke` routes are reserved for the Instance Access service binding.
- `POST /internal/github/credential` validates a strict runtime identity
  proof and forwards it only to an explicitly supplied T02 credential broker.
  The current Worker composition does not configure that broker because the
  trusted S03 runtime-authenticator and active-assignment adapters are not
  yet available; requests fail closed with 503 until both are wired.

`apps/gateway/src/ui` owns the SSR views and request handler. The service
adapter in `src/services/portal-service.ts` rechecks GitHub access and calls
the versioned Control Plane routes. Its Control Plane response payloads are
parsed with the frozen `@praetorium/contracts` schemas.

## Local setup

Use owned HTTPS origins and a real GitHub App before deploying. Copy
`.env.example` into your local secret manager or `.dev.vars`, replace every
example value, and configure the declared `USER_AUTH_STATE`, `EPHEMERAL_CODES`,
`GATEWAY_KV`, and `CONTROL_PLANE` bindings in `wrangler.toml`. The sample
configuration deliberately cannot start: missing/example origins, secrets,
keys, IDs, or bindings fail closed.

`GATEWAY_SIGNING_KEY` is JSON containing an active `kid` and private P-256 JWK.
The public key registry in `GATEWAY_KV` must already contain the matching
public JWK with active status. `GATEWAY_TOKEN_ENCRYPTION_KEY` is a base64url
encoding of exactly 32 random bytes, paired with a stable key ID. Keep all
pepper and service-auth secrets independent and private.

The Worker imports the active private signing key and token-encryption key once
per isolate, reusing each only while its exact secret value (and, for token
encryption, key ID) is unchanged. Each request that signs or verifies a
credential loads the public registry on demand; login, portal, direct-entry and
liveness requests do not load it. The KV read sets `cacheTtl=30`, Cloudflare's
minimum, and does not add a second Worker cache. Cloudflare documents KV as
eventually consistent across locations, with changes sometimes taking 60
seconds or more to become visible elsewhere, so this does not provide a strict
global 30-second revocation bound ([KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). Public JWKS responses use `max-age=30`, so
consumers may retain a returned key for a further 30 seconds. Retired keys
remain published for existing credentials, while compromised keys are rejected
by Gateway and omitted from JWKS. Already issued grants remain valid only until
their embedded expiry.
`/healthz` checks process liveness without requiring deployment bindings;
`/readyz` still validates the active signer and configured broker before
reporting ready.

Run the focused package checks from the repository root:

```sh
pnpm --filter @praetorium/gateway check
pnpm --filter @praetorium/gateway build
pnpm --filter @praetorium/gateway dev
```

The Gateway tests cover strict response parsing and service authentication,
the OAuth browser binding, session/CSRF checks, publisher receipts, binding
revalidation, direct entry, and one use handoff behavior. They use test
adapters and do not certify a real GitHub App, deployed Cloudflare bindings,
producer image or browser ingress. Those remain deployment and T14 acceptance
gates.
