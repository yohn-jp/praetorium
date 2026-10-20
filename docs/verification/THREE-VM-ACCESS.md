# Public access verification for the three-VM migration

Observed 2026-10-20 from 10:52 to 11:00 UTC against Praetorium source
`59449ffd65a9210435b882504933cbaf57db1418`. This is sanitized, read-only
evidence for [Issue #24](https://github.com/yohn-jp/praetorium/issues/24).
The integration owner applied the public-host Certificate/TLSStore/fallback
changes during this observation window; the post-apply state below is the
latest sample. This worker made no production changes.

**Issue #24 remains open.** The public network forwarding path works, but
public HTTPS still serves a certificate without the application hostname and
the deployed Instance Access image rejects that public Host. No authenticated
browser session or GitHub write was verified.

## Public TLS and routing

`getent ahostsv4 1423923158.scriptorium.yohn.jp gateway.yohn.jp` returned
`222.224.247.206` for both names. Issue #24 separately records the Cloudflare
DNS-only wildcard CNAME. Name resolution alone does not verify TLS or routing.

Strict TLS verification failed with curl exit 60 for both the public address
and direct Runtime address:

```text
curl --max-time 15 -sS -I -v https://1423923158.scriptorium.yohn.jp/ -o /dev/null
curl --max-time 15 -sS -I -v --resolve 1423923158.scriptorium.yohn.jp:443:10.7.0.31 https://1423923158.scriptorium.yohn.jp/ -o /dev/null
curl: (60) SSL: no alternative certificate subject name matches target hostname '1423923158.scriptorium.yohn.jp'
```

Both handshakes returned the same publicly trusted Let's Encrypt certificate:

```text
subject: CN=instances.praetorium.yohn.jp
issuer: C=US, O=Let's Encrypt, CN=YR1
SANs: DNS:*.instances.praetorium.yohn.jp, DNS:instances.praetorium.yohn.jp
valid: 2026-10-18 03:57:38 UTC through 2027-01-16 03:57:37 UTC
SHA-256 fingerprint: F5:C1:76:94:01:3E:F7:EB:9C:1F:93:6A:CE:A6:C8:3A:8B:AB:DF:5F:D7:20:9E:FB:F4:26:A3:7B:06:15:FF:82
```

After the owner's apply, the live Certificate requests
`instances.praetorium.yohn.jp`, `*.instances.praetorium.yohn.jp`, and
`*.scriptorium.yohn.jp`, but is `Ready=False` with reason `RequestChanged`.
`TLSStore/default` now exists and references `praetorium-instance-tls`. The
public and direct handshakes still serve the old certificate from that Secret;
the new SAN is not yet live.

For HTTP inspection, unauthenticated GET requests used browser navigation
headers and `curl -k` only to bypass the known TLS-name failure. Public and
direct Runtime responses were identical:

```text
GET https://1423923158.scriptorium.yohn.jp/platform/handoff  -> 404 application/json: {"error":{"code":"INSTANCE_NOT_FOUND"}}
GET https://1423923158.scriptorium.yohn.jp/_platform/handoff -> 404 application/json: {"error":{"code":"INSTANCE_NOT_FOUND"}}
```

The server Date header was `Tue, 20 Oct 2026 10:59:58 GMT`. No cookie, handoff
code, authorization header, or query parameter was sent. These GETs are not a
handoff POST test. The matching certificate fingerprint and identical
response from public and direct Runtime paths show that the existing public
forwarding path delivers the original TLS SNI and HTTP Host to Runtime
Traefik/Instance Access. No firewall or NAT change is indicated by these
results.

The screenshot path `/platform/handoff` is not emitted by the current Gateway
renderer. Current source renders a form POST to
`https://<repository_id>.scriptorium.yohn.jp/_platform/handoff`; Instance
Access accepts that POST, checks the Gateway `Origin`, exchanges the one-use
code, sets host-only Secure cookies, and returns a 303 to `/`. Current source
does not establish whether the screenshot came from old HTML, a saved
bookmark, or another redirect.

## Read-only Runtime inspection

SSH through `runtime.praetorium.vm` succeeded. `k3s` was active and the sole
Node was Ready on Kubernetes `v1.35.9+k3s1`, with `control-plane,etcd` roles.
Traefik had two Ready replicas; Instance Access had one Ready replica and its
ClusterIP Service had one endpoint.

| Resource | Latest live result |
| --- | --- |
| `praetorium-system/praetorium-instance-origin` Certificate | Requests the three SANs above; `Ready=False`, reason `RequestChanged`; current Secret still serves only the legacy SANs |
| `praetorium-system/TLSStore/default` | Present; default certificate Secret is `praetorium-instance-tls` |
| `praetorium-system/praetorium-instance-access-fallback` IngressRoute | Matches `^[1-9][0-9]*\.scriptorium\.yohn\.jp$`; `/_platform` priority 1000 and catch-all priority 1 |
| Ready application route for repository `1423923158` | Still matches `ins-01m56estantnhv8ba5j1pcnnqj.instances.praetorium.yohn.jp` at priority 10 |
| Instance Access Service | Ready deployment; one live endpoint |

The public fallback is now present and wins ahead of the lower-priority
application route. The Ready application route itself has not been moved to
the stable repository Host, so ordinary traffic for
`1423923158.scriptorium.yohn.jp` is not yet demonstrated to reach the Ready
Scriptorium service.

The Instance Access ConfigMap contains
`INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX=instances.praetorium.yohn.jp` and
`GATEWAY_ORIGIN=https://praetorium.yohn.jp`. The live Instance Access image is
still
`ghcr.io/yohn-jp/praetorium/instance-access@sha256:6a3f9a01431c713c25c1797b6ba0d23cb709dda7d318d387d6bdb8a5241c29a4`.
The handler returns `INSTANCE_NOT_FOUND` for the valid public application
host, while current source parses `repository_id.scriptorium.yohn.jp` through
`applicationFromHostname`. The deployed image is therefore behind the current
source contract. The Ready application workload uses
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

The latest owner instruction identifies `gateway.yohn.jp` as forwarding via
the default-gateway OPNsense router at `10.7.0.1`, not a Caddy deployment.
Comparing the public endpoint with direct Runtime SNI/HTTP responses confirms
that forwarding works and preserves Host/SNI. No edge or firewall mutation is
needed for the observed failure. Older tracked Caddy guidance and the
2026-10-18 Caddy status record describe a previous deployment path and are not
an acceptance requirement under the latest owner decision.

## Remaining acceptance gates

Public HTTPS remains **BLOCKED** until cert-manager issues the requested
public wildcard certificate and the public endpoint presents its SAN. Hosted
entry remains **BLOCKED** until the current Instance Access image is built and
deployed, and the Ready application route is verified on the repository Host.

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
