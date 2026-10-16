# `@praetorium/auth`

Provider-neutral authentication primitives adapted from the inspected Arcadia Platform auth package: PKCE and one-use login attempts, sessions and cookies, token digests, signed grants, key rotation/JWKS, one-use handoff, refresh rotation, and MCP credentials.

The package deliberately has no Cloudflare, GitHub or persistence dependency. Gateway adapters implement the store interfaces. Repository grants use the strict T01 contract; package-local user and session types keep provider and persistence details out of the auth primitives. No source per-user instance ownership policy is retained here.

GitHub user access and refresh tokens must be encrypted with the exported token vault before persistence. Installation credentials are minted by `@praetorium/github` for one repository and runtime binding only.
