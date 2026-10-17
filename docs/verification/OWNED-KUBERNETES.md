# Owned disposable Kubernetes API evidence

This is a bounded Kubernetes API verification record for the T12/T14 work. It
does not certify the integrated platform, producer, runtime networking, or a
deployment. The evidence below comes from one explicitly owned disposable Kind
cluster and server-side dry-run Pod requests; it includes no production
Cloudflare, D1, DNS, K3s, NixOS, GitHub App, registry, or Scriptorium access.

## Environment and source cuts

The owned cluster was `praetorium-owned-kube-20261017`, context
`kind-praetorium-owned-kube-20261017`, inventory cluster ID
`clu_01M53W7T8W8R9129J1PM8ZS4M2`. Its sole node was
`praetorium-owned-kube-20261017-control-plane`, UID
`08f56718-0ca8-4c15-b864-6a9b68819980`, marked `praetorium.io/disposable=true`
and Ready. Kind was v0.31.0; the API server reported Kubernetes v1.35.0. The
node image was pinned as
`kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f`.
Every Kubernetes command used the cluster's private explicit kubeconfig and
context. Its kubeconfig contents are not included here.

The tested source checkpoint that contains the Pod policy is
`137bc1799663a06c03c0d8e260d401b7cdb8f359`; this evidence note is being
committed onto `7bf2609d935f60c15da9b0e300ecf473c910533d`. The only change
between those heads is verification-document formatting, and the tenant Pod
policy YAML has the same SHA-256 at both heads. The evidence spans these exact
source cuts:

| Operation                                    | Source cut                                                                                                           | Result                                                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial product `applyGuardedBundle` attempt | `0a28ccdddc82bf00694719e5c9bed55c370e3bc0`                                                                           | Applied the 14 admission guards, then stopped at live type checking. It did not apply the full bundle or bootstrap RBAC.                                                                                               |
| Canonical NetworkPolicy VAP update           | `02b0d196c61bcb1993106a441bed683586eef6ff`                                                                           | Updated only that VAP from a policy-only render; its same-name binding was included unchanged. The VAP advanced to generation 2, but its resulting status omitted `typeChecking`, so readiness remained unsatisfied.   |
| Tenant Pod policy behavior candidate         | worker commit `424f285adfb53150681b0cbe94d557cc61b9a8db`; equivalent policy content is present in main at `137bc179` | Bound, isolated API behavior probe described below. The candidate YAML SHA-256 is identical at both commits and at the current note head, but this was not a canonical bundle application or live workload deployment. |

The v1.35 live OpenAPI documents showed `Container.resources` referring to
`ResourceRequirements`, whose `requests` and `limits` are maps with Quantity
values. The Quantity schema was `oneOf` string/number and had no `type` or
`x-kubernetes-int-or-string`. The selected public schemas were saved outside
the repository with SHA-256
`2d7ebb31cdea5481501dbdd73a12b93eaedaba21cbb784e8e5a7c38e4ea71c58`. This
matches the observed static CEL type-check warnings that `requests` and
`limits` were undefined, and motivated checking the policy's narrowly scoped
dynamic map expression against the actual API server.

## Guarded apply and status behavior

At source `0a28cc`, the actual guarded apply path reached API discovery, strict
server-side dry-run of the rendered policy/RBAC bundle, application of exactly
seven VAPs and seven bindings, and the live status wait. It stopped because
three expression warnings remained: one in the NetworkPolicy policy and two
in the Pod policy. The report recorded `fullBundleApplied: false`; the
bootstrap ClusterRole and ClusterRoleBinding were absent afterward. The
attempt report SHA-256 is
`6a7068623aceb22182e999b15b83a8c653fc21b3609c70c5e0220d824aa69ece`.

The NetworkPolicy correction at `02b0d19` replaced unsupported `size()` calls
on typed Kubernetes structs with optional-field checks. Its policy-only render
had two documents and SHA-256
`c538bce63b797bae16ca5a5d7b0230d9e7ebdc7558a21512a0a712da3a8402c7`. A strict
server-side dry-run passed, and the actual VAP update kept the same UID while
advancing generation 1 to 2. Before the update, generation 1 had one
expression warning. Afterward, the live object reported only
`status.observedGeneration: 2`; it had no `status.typeChecking` field. The
readiness gate requires a current type-check status object, including for a
zero-warning policy, so this update did not pass the gate. The same VAP's
`metadata.managedFields` was absent from both before and after snapshots. No
status was patched manually. A fresh, temporary unbound candidate VAP in the
same API server did report `observedGeneration: 1` and `typeChecking: {}`.
The API server log query (`kubectl logs` from the owned API server pod with
`--since=2h --timestamps=true`, filtered to the exact canonical policy and two
temporary candidate names) ran from `2026-10-17T03:15:15Z` to
`2026-10-17T03:15:15Z` (command start/end in the same second), searching the
log interval approximately `2026-10-17T01:15:15Z`–`2026-10-17T03:15:15Z`, and
returned zero lines. The filtered empty-log artifact SHA-256 is
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Thus the
evidence records an unresolved update-status quirk; it does not establish its
controller cause or justify weakening the gate.

The later `bff7145` NetworkPolicy input-validation change was not applied to
this existing cluster. A current product render against the owned inventory
exited 2 before emitting a bundle because required operator inputs were
absent: HTTPS service origins, Kubernetes API/CNI destinations, GitHub App and
Gateway identity/key references, BuildKit endpoints/repositories, signing
configuration, target platform, cache-retention bounds, and immutable service
image digests. The exact output is retained at
`/tmp/praetorium-owned-kube-1000-20261017/render-blocker-bff.log` (SHA-256
`17b0172e02d2186b7cd33be3934f02fd9d65e52045e39625cd9fb64a181fe51f`). No
placeholder values were supplied to force a full render.

## Tenant Pod policy API behavior

The temporary VAP candidate was copied from the exact Pod policy in worker
commit `424f285`. Its source YAML SHA-256 was
`92ea8e03a7b89871c216bfaa311fd86e06ed678a5bdd1702b402672d2b2f1802`; the
source expression hashes were regular validation 3
`1db78d3f2693d966a31f100f0e3568b4cc254ecf436fdeec2408665d0b2b61fa` and init
validation 4
`449cfcdd301d113e0d299f6ae296b80a8371450b6cbdd0e09506264f0d0a016d`. The
candidate changed only its name/owner metadata and namespace selector. Its
unique namespace label did not include either canonical tenant selector
label. A same-name temporary binding selected only that unique label.

The candidate reached generation/observedGeneration 1 with `typeChecking: {}`
and zero warnings. Because binding propagation is asynchronous, a known-invalid
Pod missing all regular-container resources was submitted as a server-side
dry-run readiness canary before the behavior matrix. It was initially accepted
twice, then rejected by the exact candidate policy and binding on the third
attempt. The matrix began only after this binding-specific denial. The
readiness canary and all matrix requests used `kubectl create
--dry-run=server`; all images had `imagePullPolicy: Never`. No Pod was
persisted, started, or pulled.

| Server-side dry-run case after the readiness canary                | Outcome  | API observation                                                                      |
| ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| Valid regular and init containers, with all six request/limit keys | Accepted | Returned object retained both resource maps.                                         |
| Missing regular-container limits                                   | Denied   | Exact candidate Pod policy message. Repeated after all other cases and denied again. |
| Missing regular-container resources object                         | Denied   | Exact candidate Pod policy message.                                                  |
| Missing init-container limits                                      | Denied   | Exact candidate init-container policy message.                                       |
| Missing init-container resources object                            | Denied   | Exact candidate init-container policy message.                                       |
| Missing regular-container requests, limits retained                | Accepted | API defaulted requests to the supplied limits in the returned object.                |
| Missing init-container requests, limits retained                   | Accepted | API defaulted requests to the supplied limits in the returned object.                |

The accepted request omissions are expected API defaulting, not a policy bypass:
the post-defaulted object was inspected and included all required keys. This
probe did not exercise a denial for each individual CPU/memory/ephemeral-storage
key, a persisted workload, an image pull, or container isolation. The namespace
carried the Kubernetes `restricted` Pod Security labels and the valid dry-run
passed; no separate Pod Security denial case was run.

The complete probe report, including timestamps, VAP/binding UIDs, defaulted
objects, denials, and cleanup responses, is outside the repository at
`/tmp/praetorium-owned-kube-1000-20261017/pod-dyn-bound-probe-ready.json`,
SHA-256 `9da37813c798d04decd840ac805305862aff57102abccf51d190ee542d501df7`.
The report’s `candidateVapSpecificDenial` summary flag is incorrectly false for the two init-container denial cases: the probe classifier searched only for the regular-container message. Independent review checked the actual denial strings, which name the exact candidate policy/binding and init-container validation message. The original report and hash are preserved; these two flags are not used as the proof.

The first no-canary run was superseded because it started before the binding
was observed by admission; its initial regular-limit acceptance is not used as
behavior evidence. After the controlled run, the temporary binding, candidate
VAP, and namespace were each deleted with a UID precondition (HTTP 200) and
verified absent. The namespace had no persisted Pods. Canonical Pod policy and
binding objects, bootstrap RBAC, and workload namespaces were not changed by
this probe.

## Remaining T12/T14 gates

- The actual policy API tests above are partial evidence, not a complete
  `deploy-infrastructure.mjs create/apply` run. The inventory could not render
  a deployable full bundle; no owned fresh-cluster create path was verified in
  this unit.
- NetworkPolicy API schema/type checking was exercised, but no packet-flow
  test was performed. Kind's default CNI is not counted as NetworkPolicy
  enforcement here: CNI enforcement is **NOT_CHECKED**.
- S01-S05 hosted handshakes and an accepted immutable Platform composition are unavailable;
  this API probe did not use a Scriptorium image or runtime.
- No GitHub App user authorization, OCI BuildKit/registry artifact, browser
  entry, ingress, workload startup, cluster isolation/capacity, recovery, or
  stable/pinned rollout was tested here.

The result is **partial Kubernetes API implementation verification only**.
T12 deployability and T14 integrated acceptance remain unverified; production
infrastructure was not applied.
