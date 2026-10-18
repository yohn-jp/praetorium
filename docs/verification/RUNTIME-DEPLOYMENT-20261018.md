# Runtime deployment — 2026-10-18

The owner-authorized production Runtime deployment completed at **04:56:09 UTC**
with `scripts/deploy-k3s.mjs --apply` exit **0**, using source
`ffaf820b4d62c209ed9a5fdff5f5b2c4be23f51e` and the existing private production
Inventory and complete eleven-role `secret-files.json`.

| Check                                            | Observed result                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact pnpm 11.18.0 frozen install and full check | PASS; 29/29 test tasks, boundaries and schema generation passed.                                                                                                                                                                                                                                                       |
| GitHub verification                              | [Run 39098634361](https://github.com/yohn-jp/praetorium/actions/runs/39098634361) passed; image publication job skipped.                                                                                                                                                                                               |
| Complete bundle strict server dry-run            | PASS, 48 resources.                                                                                                                                                                                                                                                                                                    |
| Admission readiness                              | All seven policies observed their current generation with zero type warnings; exact Deny bindings verified before application RBAC and workloads were applied.                                                                                                                                                         |
| Controllers                                      | Flux 2.9.6, Traefik chart 41.6.1 and cert-manager v1.21.2 installed; both HelmReleases Ready.                                                                                                                                                                                                                          |
| Secret registration                              | Thirteen namespace-local Kubernetes Secrets created from eleven roles; subsequent retries matched existing data and performed no implicit rotation.                                                                                                                                                                    |
| Applications                                     | Provisioner, Instance Access, Build Worker and Prometheus each 1/1 available; observed application containers had zero restarts.                                                                                                                                                                                       |
| BuildKit                                         | Actual Build Worker container reached the existing production BuildKit over mTLS; `debug workers` returned one worker supporting linux/amd64. No build, cache deletion or daemon restart was performed by this probe.                                                                                                  |
| Provisioner IngressRoute admission               | PASS, nine real API dry-run cases using an in-memory short-lived Provisioner SA token. Canonical renderer output accepted (201); eight routing escape cases denied by the exact policy/binding (422). No route persisted. Disposable namespace removed with its recorded UID; independent follow-up confirmed absence. |
| ACME                                             | Both instance-origin and Build notification certificates Ready through production ACME and Cloudflare DNS-01.                                                                                                                                                                                                          |
| HTTPS notification receivers                     | Actual Traefik Service reached through a scoped Kubernetes port-forward; public CA and hostname validation passed for both receiver hosts. Each returned 401 without auth and 202 with its canonical token.                                                                                                            |

Two deployment defects were corrected before workloads were admitted: the Build
notification port name exceeded Kubernetes' fifteen-character limit, and the
IngressRoute policy used `.size()` on structural CRD objects. The latter now
requires the canonical fields and explicitly forbids the pinned Traefik schema's
optional routing fields. The admission guard remained fail-closed throughout.

Private evidence is retained under `/data/praetorium/production/verification`,
including `runtime-apply-ffaf820-045305.json`,
`typed-ingress-server-dry-run.json`, `build-worker-buildkit-mtls.json`,
`runtime-notification-https.json` and
`ingressroute-admission-6624323b054f84ec04a29687.json`. These records contain no secret values.

## Remaining acceptance

- **NOT_CHECKED:** Public Runtime ingress through the owner's VPS/WireGuard path.
  The internal port-forward result does not establish public reachability. Keep
  Control Plane notification URL settings disabled until that path is verified.
- **NOT_CHECKED:** Hosted candidate build and GHCR output push using the deployed
  Build Worker. Credential authentication alone does not prove package writes or
  anonymous tenant image pulls.
- **NOT_CHECKED:** Production release-policy activation and signed candidate
  admission, followed by the actual Scriptorium browser/Git/lifecycle acceptance.
  Cloudflare management and manual Secret registration remain owner-operated.

This record establishes Runtime infrastructure deployment and the listed checks;
it does not mark any whole G1–G9 goal complete or replace Hosted acceptance.
