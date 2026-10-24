# Service MCP publishing: OAuth and on-demand runtime (v1)

## Purpose and scope

Praetorium provides **one reusable MCP access mechanism for registered applications**.
Scriptorium is the first consumer, not the owner of OAuth, Wake, or client
credential persistence. No new MCP proxy, broker container, or per-application
authorization server is introduced.

A service opts in by shipping its own HTTP Streamable MCP handler at `/mcp`
and returning Protected Resource Metadata on
`/.well-known/oauth-protected-resource`, with `resource` equal to its
**stable HTTPS application origin** and `authorization_servers` naming the
Praetorium Gateway. A service validates Praetorium's **audience-bound, short-lived**
JWT itself using its assigned issuer and JWKS. Non-MCP services do not acquire
an MCP handler just because they run under Praetorium.

Only registered `AppIdentity` namespaces can use the generic Gateway protocol.
The initial product registry currently contains `scriptorium`; enrolling a
second service is a separate application-identity change, not an MCP rewrite.

## End-to-end client flow

1. Configure the MCP client with `https://<registered application hostname>/mcp`.
   The hostname is stable across Pod/epoch replacements; never use a physical
   Pod address or the Gateway entry page as the MCP server URL.
2. An unauthenticated client receives `401` with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
   This works with a running service and through Instance Access while stopped.
   Discovery is public and MUST NOT wake the service. Both
   `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-protected-resource/mcp` serve the same origin-bound
   resource metadata, including through the stopped-instance fallback.
3. Protected Resource Metadata names the Praetorium Gateway origin.
   Gateway `/.well-known/oauth-authorization-server` describes
   `/oauth/authorize` and `/oauth/token`, and advertises
   `client_id_metadata_document_supported: true`. New ChatGPT connections use
   CIMD: the HTTPS client ID identifies the client metadata document, whose
   `client_id` must match exactly and whose `redirect_uris` constrain redirects.
   Gateway fetches only the reviewed `https://chatgpt.com/oauth/client.json` and
   `https://chatgpt.com/oauth/<callback-id>/client.json` forms, without redirects,
   cookies or authorization headers, with a bounded body and timeout. Other
   metadata origins require a separately reviewed client policy.
   The public-client method is `none` with PKCE S256; a metadata document's
   supported methods must include `none` even if its legacy preference names
   `private_key_jwt`. Gateway does not advertise or accept `private_key_jwt`.
   Metadata is fetched afresh for authorization and token exchanges; upstream
   unavailability fails closed and does not silently select DCR.
   Existing registered client IDs, authorization codes and refresh credentials
   remain valid under the existing checks. `/oauth/register` remains available
   for legacy DCR clients and explicit administrator pre-registration, but is
   no longer advertised as the registration mechanism for new connections.
   Administrators may pre-register a public client with the connection's exact
   redirect URI and configure its returned client ID using provided OAuth
   credentials with method `none` (no secret). Registration alone gives no
   repository access. No existing clients are deleted or assigned an automatic
   migration deadline.
4. Authorization Code + PKCE S256 starts at Praetorium. The existing GitHub
   OAuth login creates the authenticated Gateway browser session; a separate
   **explicit MCP consent** names the client, stable service origin and requested
   `read`/`write` scope. The Gateway verifies current repository permissions,
   binds a one-use code to client, redirect, resource, user, consented scopes,
   and the session, and redirects that code to the registered client URI.
5. The token endpoint consumes the one-use code and verifies the code verifier
   and all bindings. Praetorium issues a maximum 300-second ES256 access grant
   for the **current** repository, origin, physical runtime identity and epoch,
   plus a rotating refresh credential limited to the originating Gateway
   session. Tokens cannot be exchanged across different application origins.
   Refresh rechecks session state and current GitHub repository authority.
6. The client sends `Authorization: Bearer <grant>` directly to the stable
   `/mcp` endpoint. If running, the application validates the grant, checks
   the module's current authorization and invokes the same Core action/proposal
   authority as UI/API. A Bearer grant never bypasses write approval.
7. If stopped, the same stable-origin request reaches Instance Access via
   Traefik fallback. Instance Access validates hostname and bearer shape,
   passes only the grant and its server-derived service binding to the Gateway
   over its existing authenticated service binding, and **does not read, buffer,
   proxy or replay the original MCP body**. Gateway validates the signed grant,
   current GitHub authorization, binding, configured artifact, wake quota and
   stale/failed conditions before requesting the existing Control Plane
   `desiredState=running` CAS.
8. Fallback returns `503 INSTANCE_STARTING` and `Retry-After`. Once the Pod
   becomes ready, the client retries the **same** URL. If the grant expired
   during startup, the client refreshes it at the Gateway token endpoint.
   Neither wake nor JWT verification requires a Gateway proxy for an already
   running service's ordinary MCP messages.

## Trust boundaries

- Gateway OAuth and Durable Objects own the client registry, single-use codes,
  refresh credential state, GitHub login, current repository authority and
  issuance/revocation rules. OAuth state does not live in application Pods.
- Instance Access is a stopped-instance routing component, not a resource
  server. It accepts only its registered hostname and forwards only a bounded
  bearer grant to the Gateway; anonymous requests **never enqueue a wake**.
- The individual service Pod owns MCP tool dispatch, per-connection sessions,
  domain read/compute/proposal policy and final bearer validation. It accepts
  grants only for its assigned audience, repository, physical identity and epoch.
- Existing Gateway signing keys/JWKS, EphemeralCode Durable Objects,
  per-user sessions, fresh GitHub permission checks, rate limits and Control
  Plane lifecycle remain the authority. No parallel credential store or
  second Wake implementation is permitted.
- Runtime replacement or authorization revocation may invalidate a current
  grant. Client obtains a fresh grant through its bound refresh token; old
  grants must not be reinterpreted as access to the new epoch.
- All OAuth and MCP links use HTTPS. Never put JWTs, authorization codes,
  session cookies, refresh credentials or private work content into URL logs,
  repository files, or browser assets.
- Browser one-use handoff/CSRF cookies and MCP OAuth are **different clients**
  of the same Gateway authorization and runtime lifecycle; neither silently
  substitutes the other's credentials.

## Initial provider binding

Scriptorium's full/selected Hosted image must include the existing `mcp`
module. It exposes `/mcp` and resource metadata at its assigned origin.
The optional module keeps its previous `/api/projects/:id/modules/mcp/streamable`
endpoint, but the public client uses the new stable path.

## Verification gates

- OAuth discovery works with both ready service and stopped fallback, and does
  not wake on metadata or unauthenticated MCP requests.
- Dynamic registration cannot redirect to unregistered URI; authorization code
  is one-use and PKCE-bound; client/resource mismatches fail closed.
- Explicit consent, CSRF, fresh GitHub permission and session validity gate
  initial/refresh grants; rotated refresh cannot be reused.
- Signed grants with wrong audience, repository, epoch, actor permission or
  authorization revision do not wake; valid grants trigger exactly the existing
  Control Plane desired-state path. No original JSON-RPC bytes are replayed.
- Verify with a real stopped Hosted deployment and a remote MCP client before
  claiming deployment acceptance. Tests/commits alone do not establish
  real ChatGPT OAuth/Wake interoperability.

This contract is for **any registered service** that opts in to MCP. No
Scriptorium-specific branches are required in OAuth issuance, wake, or routing.
