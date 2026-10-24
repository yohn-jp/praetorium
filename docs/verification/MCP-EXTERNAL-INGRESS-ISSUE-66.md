# Issue #66: public MCP ingress and OAuth repair

Observed 2026-10-24 UTC (2026-10-25 JST), based on main `66d7122`.
PR #65 is already merged; its DCR metadata change is not duplicated here.

## Confirmed causes and production changes

1. **WAN TCP 443 bypassed the existing Caddy listener.** OPNsense's
   `Fowarding Inbound DMZ` rule (UUID `00cec7c9-4c89-4254-911d-88954940f200`)
   redirected public traffic to `10.200.1.11`, while the internal source used
   another path. At 15:10:14 UTC the GitHub runner's SYN from
   `20.221.70.226:62480` to `222.224.247.206:443` was logged as DNAT followed
   by pass to `10.200.1.11:443`; PF state remained `CLOSED:SYN_SENT`.
   The external runner timed out. This was a source-dependent TCP failure,
   before SNI, HTTP paths or OAuth.

   Added a sequence-100 **no-RDR exception for IPv4 TCP 443 to the WAN address**
   on `opt2`/`pppoe0`, followed by a logged stateful inbound allow to that
   address/port. Other DNAT rules remain present. The actual loaded rules are:

   ```text
   no rdr log on pppoe0 inet proto tcp from any to (pppoe0) port = https
   pass in log quick on pppoe0 reply-to (pppoe0 61.115.19.136) inet proto tcp from any to (pppoe0) port = https flags S/SA keep state
   ```

   The existing Caddy SNI matcher for `scriptorium.yohn.jp` and
   `*.scriptorium.yohn.jp` forwards raw TCP to `10.7.0.31:443`. This config
   was read and retained. Captured on `vlan0907` at 15:12:05.549 UTC:
   `10.7.0.1:57769 -> 10.7.0.31:443` SYN, SYN/ACK, ACK, ClientHello and
   server TLS data. Traefik's live IngressRoute matches
   `Host(1289100245.scriptorium.yohn.jp)` with priority 10 and routes to the
   running instance Service on port 3000. No DNS, Caddy, Traefik or tenant
   deployment was changed.

2. **ChatGPT CIMD authorization threw before making its metadata request.**
   `fetchMetadataClient` used `redirect: "error"`. The deployed Worker and
   workerd reproduction both failed before login. The live anonymous CIMD
   authorization returned 503 in 0 ms. workerd reported:

   ```text
   TypeError: Invalid redirect value, must be one of "follow" or "manual"
   ("error" won't be implemented since it does not make sense at the edge;
   use "manual" and check the response status code).
   ```

   Changed to `manual`; existing non-2xx rejection rejects redirects without
   following their target. Added a workerd regression that resolves ChatGPT
   metadata and rejects a redirect toward a private address with outbound
   networking disabled. The production anonymous CIMD request then returned
   302 to `/auth/login`.

3. **The consent page suppressed the Origin required by its CSRF check.**
   After the owner reached the real consent page, Allow returned 403
   `access_denied`. The live POST had literal `Origin: null`. The consent
   page set both HTTP and HTML referrer policy to `no-referrer`. A native
   Chromium form reproduction produced `Origin: null` with that policy and
   the correct origin with `same-origin`. Changed only the consent page's
   two policy declarations to `same-origin`. CSRF cookies, token comparison,
   same-origin checks and repository authorization remain enforced. Regression
   assertions cover both the response header and HTML metadata.

4. **CSP blocked the successful consent POST's redirect to ChatGPT.** After
   the Origin repair, the real POST returned 302 but the owner remained on
   the consent page. Chromium reproduced the redirect-chain rejection with
   `form-action 'self'`; adding the exact callback origin permitted navigation.
   The consent CSP now permits only self and the validated client's callback
   origin. A delimiter-safe origin check prevents metadata from injecting CSP
   directives; regression tests cover both policy and unsafe-origin rejection.

## Backups and deployment readback

- Root-only OPNsense backup:
  `/conf/backup/issue66-before-20261024-151147.xml`, SHA256
  `48889f503ae368dc5ba88d2506f212da2d89f997dd86a0265951522265efa7a4`.
  Config was saved with OPNsense `write_config`, then
  `/usr/local/etc/rc.filter_configure`; loaded PF rules were read back.
  Rollback should remove only the two Issue #66 rules by UUID
  `aeb187d0-1727-4ca2-80a5-78d01f33b025` (NAT) and
  `53af6f04-c9a3-4ffc-8fb4-6910731fc300` (filter), then reload and verify.
  Do not restore an entire snapshot over later unrelated owner changes.
- Existing Gateway deployment before patch:
  `d8090ee7-cb92-4939-96e5-6d43e9f8faa8`.
  Downloaded its actual module and settings before changes, compared them
  again immediately before upload, and patched only the demonstrated defects.
  Existing bindings and non-secret settings were retained; secrets were kept
  server-side with the API's `keep_bindings: ["secret_text"]`.
  [Cloudflare upload metadata contract](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/).
- Module SHA256 before:
  `d19813d30c2747f1d302be678f70c24dd983523f4c2c122837f7aced8213f256`.
  After CIMD patch:
  `ed39f9bcc514309e0cc188cbd534d30fd2e274af1140872b31ca8da0193a68e8`
  (deployment `33e719d93d70420e8db0f00cc3ce03dd`). After consent patch:
  `7bb862ff651fb658bc14a4829efca8c609125d1f65fe797857fe6b138c3e5e4e`
  (deployment `4526385fd3d24418a4e342ecd6b1e0d0`). After the CSP callback fix:
  `9d1382ce190ec2861d6650b33f6de06e0468e5b894a4dba699df1a598920fc6e`
  (deployment `665338f1f6d64cb89484b929c7a57b89`).
- Private local backups and packet captures are under
  `/tmp/praetorium-issue66-private` (directory mode 0700); no credentials,
  sessions, authorization codes or raw request headers are committed here.
  This is a minimal patch of the downloaded production module, not a claim
  that all pre-existing production code has been rebuilt from this PR.

## Live results

The same credential-free probe failed before the firewall repair and passed
on rerun after it:
[GitHub Actions run 40105732643](https://github.com/yohn-jp/praetorium/actions/runs/40105732643).
Before: external TCP timeout. After: source `172.202.119.160`, WAN log shows
pass to the local WAN address, plus the upstream TLS packet exchange above.
A second external network, SSH host `stardomain` (`sv12001.star.ne.jp`), also
changed from an 8-second TCP timeout to successful system-CA-verified HTTPS
and the same probe results. Local LAN success alone was not treated as WAN
acceptance.

| Gate | Actual result |
| --- | --- |
| IPv4 DNS | `222.224.247.206`; DNS left unchanged |
| IPv6 | NO_AAAA; IPv6 HTTPS NOT_CHECKED, no address published |
| TLS | Verified hostname and system CA; TLS 1.3, wildcard Scriptorium SAN |
| `/` | 200 from both external networks |
| Anonymous POST `/mcp` initialize | 401 with Bearer canonical resource_metadata challenge |
| `/.well-known/oauth-protected-resource` | 200; resource is the instance origin, issuer is Praetorium |
| `/.well-known/oauth-protected-resource/mcp` | 404; explicitly not PASS; canonical challenge points to the working root metadata URL |
| Issuer metadata | 200; DCR endpoint, `none`, S256, read/write advertised |
| DCR | Real disposable public loopback client registered, 201; client ID kept private, no access token created |
| PKCE | S256 authorize reaches login (302); plain rejected (400); actual code exchange requires browser consent |
| ChatGPT CIMD | Before patch 503; after patch 302 to login, owner subsequently reached consent |
| Consent POST | Owner retry at 15:23:08 UTC had correct Origin and 302; subsequent CSP redirect fix pending owner retry |
| Token exchange + authenticated MCP initialize | Pending owner retry after CSP fix; NOT_CHECKED until observed |

The disposable DCR record grants no repository authority and has no token;
no unsupported deletion of Durable Object data was attempted.

## Repository verification

- Node 24.21.0; `corepack pnpm@11.18.0 install --frozen-lockfile`: PASS.
- `corepack pnpm@11.18.0 check`: initial attempt failed because a nested
  `pnpm` resolved to the host's 12.10.1. Repeated with a temporary PATH shim
  pointing nested calls at the installed 11.18.0 entry point: PASS, including
  build, lint, typecheck, tests, boundaries and schema drift. No package or
  host configuration was changed to work around this environment issue.
- Targeted metadata tests: 26 passed, including workerd; targeted OAuth and
  workerd tests after consent fix: 7 passed. Full final check also PASS.
- Initial full CI run
  [40105732607](https://github.com/yohn-jp/praetorium/actions/runs/40105732607):
  monorepo verification passed; unrelated operator-console browser fixture
  failed waiting 8 seconds for build retry navigation at
  `tests/e2e/operator-console-diagnostics.test.mjs:442`. It is not counted as
  a successful CI run and that unrelated test is not changed in this PR.
- Updated external probe including real ChatGPT CIMD login redirect: PASS,
  [run 40106585714](https://github.com/yohn-jp/praetorium/actions/runs/40106585714).
  The second external Stardomain network also passed the updated probe.
- Final PR-head CI and owner-authenticated production results will be
  recorded after they finish. Credential-free CI cannot certify a real
  OAuth consent, token exchange or authenticated MCP initialize.
