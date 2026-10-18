# Commercial UI V1 implementation evidence

This is an incremental implementation record, not final acceptance.

## D1 — shared presentation boundary

- Isolated checkout: `feat/commercial-ui-v1`, starting at `a4f346c89fd13bcf0a96732b7b90215dd28f7c67`.
- Fetched `origin/main` at `1abfcaa`; its sole newer commit changes OCI layer descriptor verification. No main merge or platform edits are needed for this UI slice.
- Read the design, implementation plan, specimen source, architecture ledger and Epic #1. Production routes and commands remain owned by the Gateway and PortalService.
- Extracted the existing exact stylesheet bytes and document envelope; `render.ts` remains the exported facade. Added typed presentation mode/context, local URL construction and composition fragment contracts for the subsequent Desktop/Mobile workers.
- Handler resolves one allowlisted `ui` choice or the presentation-only cookie. Invalid/duplicate query values fall back to a valid cookie or Desktop; query input never enters `PortalCommand` or the POST field allowlist. HTTPS choices set `Secure`, `SameSite=Lax`, `Path=/`.
- Added six focused mode/CSP test cases before implementation. Initial result: 5 failed, 18 passed. After implementation: all 23 portal tests passed, including the existing authorization/CSRF/command assertions.
- Node `v24.21.0`, Corepack `0.36.0`, pnpm `11.18.0`.
- `corepack pnpm@11.18.0 install --frozen-lockfile`: exit 0.
- Initial `corepack pnpm@11.18.0 check`: exit 1 before build; nested `pnpm` resolved to host pnpm 12.10.1. A temporary Corepack shim directory placed first in PATH fixes tool selection without changing repository configuration.
- A direct Gateway typecheck before workspace build failed because workspace package declarations had not been built. The required root check builds these dependencies first.

D2/D3 composition, dirty-form behavior, section preservation and browser acceptance are NOT_CHECKED at this stage. The mode switch is a foundation; both modes still use the baseline composition until D2 integration. Hosted producer/registry/runtime acceptance, physical devices and OS IME are NOT_CHECKED and are separate from the owned local UI fixture gate.

D1 root verification: `PATH=/tmp/praetorium-ui-toolchain:$PATH corepack pnpm@11.18.0 check` exited 0 (build, lint, typecheck, tests, provider boundaries and contract schema drift). The focused portal test was rerun after strict cookie parsing and passed 23/23. Final D4 verification will run again on the integrated implementation.
