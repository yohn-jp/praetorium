# MCP Discovery and CIMD verification

## Scope

Gateway defaults new connections to ChatGPT CIMD with `none` and PKCE S256.
Registered OAuth clients remain an administrator alternative; existing DCR
client IDs and refresh credentials retain the existing authorization checks.
No production deployment, client registration or credential deletion is part
of this change. `private_key_jwt` is not implemented or advertised.

## Read-only hosted observation, 2026-10-24

Playwright CLI used an unauthenticated browser context against the existing
application origin. No grant, cookie or manuscript content is recorded here.

| Request | Observed result |
| --- | --- |
| Application `/mcp` | 401, Bearer challenge points to root protected-resource metadata, scope `read` |
| Application `/.well-known/oauth-protected-resource` | 200, origin-bound resource and Gateway authorization server |
| Application `/.well-known/oauth-protected-resource/mcp` | 404 |
| Gateway `/.well-known/oauth-authorization-server` | 200, matching issuer, PKCE S256, `none`, DCR endpoint |

The user reports that ChatGPT displays nothing. No failing ChatGPT request,
response or trace was available. The path-specific discovery alias is a
compatibility improvement, **not a proven cause of that symptom**. A client
following the advertised challenge can already discover the root metadata.

## Producer handoff and remaining gates

- **BLOCKED — running producer discovery alias:** the current Scriptorium
  `packages/api/src/server.ts` handles only the root protected-resource path.
  Its hosted route must serve the same existing public metadata at the `/mcp`
  suffix too. This repository changes the stopped Instance Access fallback;
  it cannot certify the separately coordinated producer source or artifact.
- **NOT_CHECKED — deployed CIMD:** Gateway changes have not been deployed.
  Public discovery still describes the previous deployment.
- **NOT_CHECKED — real ChatGPT connection:** requires an updated Gateway and
  producer, then a ChatGPT connection selecting CIMD rather than a supplied
  OAuth client with an empty ID. Verify discovery, exact callback, explicit
  consent, PKCE exchange, tool listing, read-only invocation and refresh.
- **NOT_CHECKED — hosted legacy DCR continuity:** local tests exercise existing
  IDs and refresh rotation, but no existing hosted connection was exercised.
- **NOT_CHECKED — private_key_jwt:** outside this public-client implementation.

Unit tests use synthetic clients and in-memory OAuth storage. They do not
certify ChatGPT, the production producer, registry, browser consent or Wake.

## Local validation

Base: `9ea0680`, isolated branch `fix/mcp-discovery-cimd`.

- `corepack pnpm@11.18.0 install --frozen-lockfile`: **PASS** (Node 24.21.0).
- `corepack pnpm@11.18.0 check`: **PASS** after correcting the new decoder's
  Workers type requirement. All build, lint, typecheck, test, provider boundary
  and contract schema checks completed. Nested commands initially selected the
  host's pnpm 12.10.1; a temporary PATH shim invokes Corepack pnpm 11.18.0 for
  every nested `pnpm` without disabling version checks or changing manifests.
- Gateway: **36 test files / 292 tests PASS**, including 25 metadata validation
  cases and 6 OAuth service cases. CIMD and legacy DCR both exercise consent,
  PKCE exchange, replay rejection, refresh rotation and callback validation.
  CIMD metadata outages leave authorization codes and refresh credentials
  usable for retry. Unsupported client authentication is rejected.
- Instance Access: **2 test files / 16 tests PASS**. Both metadata paths are
  public and do not contact Gateway or trigger Wake in the fallback fixture.
- `git diff --check`: **PASS**.

The final check log is local at `/tmp/praetorium-mcp-cimd-check.log`; it contains
synthetic/local test output, not hosted acceptance evidence.
