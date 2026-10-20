# Public access verification for the three-VM migration

Observed 2026-10-20 from 10:52 to 11:06 UTC against Praetorium source
`59449ffd65a9210435b882504933cbaf57db1418`. This is sanitized, read-only
evidence for [Issue #24](https://github.com/yohn-jp/praetorium/issues/24).
The integration owner applied the public-host Certificate/TLSStore/fallback
changes during this observation window. The latest public and direct Runtime
TLS sample is 11:04 UTC, and the latest HTTP sample is 11:05 UTC. This worker
made no production changes.

**Issue #24 remains open.** Public HTTPS now presents a trusted certificate
for the application Host, and the public edge forwards TLS to Runtime. The
deployed Instance Access service still returns `INSTANCE_NOT_FOUND` for that
valid public Host. No authenticated browser session or GitHub write was
verified.

## Public TLS and routing

`getent ahostsv4 1423923158.scriptorium.yohn.jp gateway.yohn.jp` returned
`222.224.247.206` for both names. Issue #24 separately records the Cloudflare
DNS-only wildcard CNAME. Name resolution alone does not verify TLS or routing.

Strict TLS verification now succeeds for the public address and direct Runtime
address. The latest curl result was:

```text
curl --max-time 12 -sS -I -w 'status=%{http_code} verify=%{ssl_verify_result}\n' https://1423923158.scriptorium.yohn.jp/ -o /dev/null
status=404 verify=0
```

Node TLS inspection returned the same publicly trusted Let's Encrypt
certificate from `222.224.247.206:443` and `10.7.0.31:443` when using SNI
`1423923158.scriptorium.yohn.jp`:

```text
subject: CN=instances.praetorium.yohn.jp
issuer: C=US, O=Let's Encrypt, CN=YR1
SANs: DNS:*.instances.praetorium.yohn.jp, DNS:*.scriptorium.yohn.jp, DNS:instances.praetorium.yohn.jp
valid: 2026-10-20 10:05:42 UTC through 2027-01-18 10:05:41 UTC
SHA-256 fingerprint: 41:57:A4:0E:F5:51:E9:C1:D2:D0:EF:90:7E:60:D0:BA:29:8E:C3:AC:BE:AD:99:51:D2:38:6C:8F:39:A4:A0:61
TLS authorization: true; curl ssl_verify_result: 0
```

This supersedes the 11:00 UTC sample, when both endpoints still served the
older certificate without the public SAN and the Certificate reported
`Ready=False`, reason `RequestChanged`. The Certificate API status was not
re-read after the new certificate appeared on both endpoints.

The owner confirms `TLSStore/default` references `praetorium-instance-tls`.
All requests below used normal certificate verification. Public and direct
Runtime responses were identical at 11:05 UTC:

```text
GET  /                                                       -> 404 {"error":{"code":"INSTANCE_NOT_FOUND"}}
GET  /platform/handoff                                      -> 404 {"error":{"code":"INSTANCE_NOT_FOUND"}}
GET  /_platform/handoff                                     -> 404 {"error":{"code":"INSTANCE_NOT_FOUND"}}
POST /_platform/handoff (empty form, correct Gateway Origin) -> 404 {"error":{"code":"INSTANCE_NOT_FOUND"}}
```

The server Date header was `Tue, 20 Oct 2026 11:05:54 GMT`. The empty POST
sent only `Origin: https://praetorium.yohn.jp` and an empty
`application/x-www-form-urlencoded` body. No cookie, handoff code,
authorization header, or query parameter was sent. The response shows that
the currently deployed Instance Access path still does not recognize the
public Host; the current source would reject this empty form as
`HANDOFF_REQUEST_INVALID` after accepting that Host. The matching certificate
fingerprint and identical responses confirm that the public path preserves
SNI and Host through to Runtime Traefik/Instance Access. No firewall or NAT
change is indicated.

The screenshot path `/platform/handoff` is not emitted by the current Gateway
renderer. Current source renders a form POST to
`https://<repository_id>.scriptorium.yohn.jp/_platform/handoff`; Instance
Access accepts that POST, checks the Gateway `Origin`, exchanges the one-use
code, sets host-only Secure cookies, and returns a 303 to `/`. Current source
does not establish whether the screenshot came from old HTML, a saved
bookmark, or another redirect.

## Read-only Runtime inspection

The 11:00 UTC snapshot through `runtime.praetorium.vm` showed `k3s` active and the sole
Node was Ready on Kubernetes `v1.35.9+k3s1`, with `control-plane,etcd` roles.
Traefik had two Ready replicas; Instance Access had one Ready replica and its
ClusterIP Service had one endpoint.

| Resource | 11:00 UTC Runtime snapshot |
| --- | --- |
| `praetorium-system/praetorium-instance-origin` Certificate | At 11:00, requested the three SANs above but was `Ready=False`, reason `RequestChanged`; by 11:04 the public and Runtime endpoints both served a new certificate with the public wildcard SAN. API status after issuance was not checked |
| `praetorium-system/TLSStore/default` | Present; default certificate Secret is `praetorium-instance-tls` |
| `praetorium-system/praetorium-instance-access-fallback` IngressRoute | Matches `^[1-9][0-9]*\.scriptorium\.yohn\.jp$`; `/_platform` priority 1000 and catch-all priority 1 |
| Ready application route for repository `1423923158` | Still matches `ins-01m56estantnhv8ba5j1pcnnqj.instances.praetorium.yohn.jp` at priority 10 |
| Instance Access Service | Ready deployment; one live endpoint |

The public fallback is now present and wins ahead of the lower-priority
application route. The Ready application route itself has not been moved to
the stable repository Host, so ordinary traffic for
`1423923158.scriptorium.yohn.jp` is not yet demonstrated to reach the Ready
Scriptorium service.

At 11:00, the Instance Access ConfigMap contained
`INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX=instances.praetorium.yohn.jp` and
`GATEWAY_ORIGIN=https://praetorium.yohn.jp`. The live Instance Access image is
still
`ghcr.io/yohn-jp/praetorium/instance-access@sha256:6a3f9a01431c713c25c1797b6ba0d23cb709dda7d318d387d6bdb8a5241c29a4`.
At 11:05, the safe public and direct probes still returned
`INSTANCE_NOT_FOUND` for the valid public application Host, while current
source parses `repository_id.scriptorium.yohn.jp` through
`applicationFromHostname`. Workflow run
[39412075129](https://github.com/yohn-jp/praetorium/actions/runs/39412075129)
completed successfully at 11:05 UTC, including the Instance Access image
publication job. That run published an image; it did not deploy it. The live
deployment digest could not be independently re-read at 11:05 because the
configured Runtime `k3s kubectl` context returned connection refused for
`127.0.0.1:16443`. The Ready application workload uses
`ghcr.io/yohn-jp/praetorium/candidates@sha256:446a6a8a6703ebe54cc2ef924f71a885eabccf35b0397be6177cebb2f776ce99`;
no source-revision label tying that producer image to the current Scriptorium
contract was verified.

The `instances.praetorium.yohn.jp` suffix identifies physical Runtime hosts
(`id.instances.praetorium.yohn.jp`). It is intentionally distinct from the
stable public application origin (`repository_id.scriptorium.yohn.jp`). Keep
Gateway/Control Plane physical-host suffix settings on `instances...`; the
public app uses the separate stable Host. The shared wildcard DNS remains the
entry point; no per-repository record is needed.

## Public edge path

The owner identified `gateway.yohn.jp` as the default-gateway OPNsense router
and inspected its live Caddy configuration read-only. The owner reports Caddy
PID `57426` listening on TCP/443, with the Caddy Layer4 module installed. The
sanitized adapted listener configuration matches `scriptorium.yohn.jp` and
`*.scriptorium.yohn.jp` first in a Layer4 SNI route and proxies TCP to
`10.7.0.31:443`; a TLS wrapper follows. The physical namespace has a separate
equivalent route. The protected live Caddyfile and adapted JSON were saved in
the owner's private backup area; no Caddy or firewall configuration was
changed for this investigation.

The unprivileged admin API probe to `127.0.0.1:2019` was refused, so this note
does not reproduce or expose raw Caddy configuration. The owner's privileged
read-only process/configuration inspection and matching public/direct
certificate and HTTP responses establish the forwarding path. No edge or
firewall mutation is indicated.

## Remaining acceptance gates

Public HTTPS certificate verification is now **PASSING** for the tested
repository Host. Hosted entry remains **BLOCKED** until the current Instance
Access image is deployed and accepts the public Host, and the Ready
application route is verified on the repository Host. The Instance Access
deployment digest and Certificate API status need a read-only verification
after the owner's rollout.

Issue #24 browser acceptance also requires an explicitly owned disposable
GitHub repository and current producer support. The current
[`SCRIPTORIUM-CONTRACT.md`](../architecture/SCRIPTORIUM-CONTRACT.md) still
records hosted AccessGrant enforcement and renewable repository-scoped Git
credentials as missing. Once those gates are available, the real run must
verify all of the following without recording credentials or one-use codes:

1. Chrome GitHub login and repository authorization; Gateway renders the exact
   public Host and POST target.
2. Handoff POST Origin, successful one-use exchange, 303 to `/`, and cookie
   names/attributes; then Scriptorium UI/API/MCP response on the same origin.
3. Ready routing sends `/_platform/*` to Instance Access and ordinary traffic
   directly to the Ready Scriptorium Service.
4. Stopped bookmark behavior wakes once, shows bounded waiting, and reconnects
   without replaying an arbitrary POST body.
5. Invalid, expired, and replayed handoff denial; refresh, logout, re-entry,
   revoked permission, and unauthorized repository denial.
6. A disposable edit saved to GitHub, followed by remote content/commit
   verification and browser reload.

Existing Gateway and Instance Access unit tests exercise source-level handoff,
cookie, grant, stale-grant re-entry, and mutation-authorization behavior.
They do not prove the deployed route, public TLS, producer compatibility, or
browser acceptance. No tests were run for this evidence-only change.
