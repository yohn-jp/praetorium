# Owned disposable Kubernetes API evidence

This is a bounded Kubernetes verification record for the T12/T14 work across
two explicitly owned disposable Kind clusters. It covers product cluster
creation and ownership, a two-policy admission guard subset, and server-side
dry-run Pod and NetworkPolicy requests. It does not certify the integrated
platform, producer, runtime networking, or a deployment. No production
Cloudflare, D1, DNS, K3s, NixOS, GitHub App, registry, or Scriptorium access
was used.

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

The original tenant Pod policy behavior probe used source checkpoint
`137bc1799663a06c03c0d8e260d401b7cdb8f359`. The Pod policy YAML still has
SHA-256
`92ea8e03a7b89871c216bfaa311fd86e06ed678a5bdd1702b402672d2b2f1802` at the
verification note base `47065d2`. The evidence spans these exact source cuts:

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
the first cluster. A product render against its owned inventory exited 2
before emitting a bundle because required operator inputs were absent: HTTPS
service origins, Kubernetes API/CNI destinations, GitHub App and Gateway
identity/key references, BuildKit endpoints/repositories, signing
configuration, target platform, cache-retention bounds, and immutable service
image digests. The exact output is retained at
`/tmp/praetorium-owned-kube-evidence-20261017/current/prior-run/render-blocker-bff.log`
(SHA-256
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
`/tmp/praetorium-owned-kube-evidence-20261017/current/prior-run/pod-dyn-bound-probe-ready.json`,
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

- The policy tests above are partial evidence, not a complete
  `deploy-infrastructure.mjs create/apply` run. The follow-up below verified
  the product `create` action on a fresh owned cluster; the full infrastructure
  bundle remained blocked by 25 missing operator inputs and was not applied.
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

## Fresh-cluster and IPv6 candidate follow-up

On 2026-10-17, the product `node scripts/deploy-infrastructure.mjs create`
path successfully created and ownership-verified a second disposable Kind
cluster. Creation used Praetorium main `9a9b692f6965a9a4472cac20235c02eced2893a7`;
the selected deployment, guarded-apply, readiness, and Kubernetes policy files
were rechecked unchanged at main `47065d299d3c74ad27e0bf42685c29708c0b663b`.
The environment belonged to UID 1000 and used Kind v0.31.0, Kubernetes
v1.35.0, one Ready node UID
`ab2091e1-c844-4201-9859-2a43d97056e1`, and the pinned image
`kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f`.
The private kubeconfig contents are excluded from the evidence archive.

The successful `create` action created only the disposable cluster. Its result
reported `clusterVerified: true` and 25 missing operator inputs, including
Gateway/Control Plane origins, Kubernetes API/CNI destinations, GitHub App
references, BuildKit endpoints and repositories, signing/trust configuration,
cache bounds, target platform, and immutable service image digests. No
infrastructure bundle, bootstrap RBAC, or workload was applied. The exact
create report SHA-256 is
`d4cca5a5046df70fe0418140cb51dac3ec18e10ee6fffef083db0e328d06dc89`; the
fourth isolated Kind startup attempt succeeded after three failed attempts
whose exact causes are retained in the private evidence archive.

On that fresh API server, the current-main NetworkPolicy and tenant Pod VAPs
and their Deny bindings were rendered for the actual cluster ID, server-side
dry-run checked, and applied as a two-policy guard subset. This was not the
full seven-policy staged-apply path. Both VAPs reported generation and observed
generation 1 with `typeChecking: {}`. Before and after the IPv6 candidate
probe, their UIDs and generations were identical:

| Canonical object | UID | Before | After |
| --- | --- | --- | --- |
| `praetorium-provisioner-tenant-networkpolicy` VAP | `8a9284b7-9283-4ab3-ab04-4ba860594b74` | gen 1 / observed 1 / `{}` | gen 1 / observed 1 / `{}` |
| `praetorium-tenant-pods-restricted` VAP | `45a517e9-0374-4fc4-aa4a-0d134dd1ab78` | gen 1 / observed 1 / `{}` | gen 1 / observed 1 / `{}` |
| NetworkPolicy VAP binding | `723b5e20-ddde-4ab5-b76f-2844c08d6b5b` | gen 1 / Deny | gen 1 / Deny |
| Pod VAP binding | `e01b6cf2-285d-4663-aa18-8d270d361dde` | gen 1 / Deny | gen 1 / Deny |

The IPv6 correction under test was still on worker commit
`522af7c99499f0e67d974f6e6043343e0c10241c`; it was not an ancestor of main
`47065d2`, whose renderer and policies still contained the old
`::ffff:0:0/96` exception. The test compiled that exact worker renderer with
Node v24.21.0 and esbuild 0.28.1, called `renderStopped` with the real cluster
ID, and server-side dry-ran the resulting NetworkPolicy. The candidate source
hashes were renderer
`a5ae8a7639ebc4ef8eaff9c3e15b6354e04e4627a54365314f6f62f2be4da039`, VAP
`3661165a86bc5739cba0cac2eac7d3a592997c743424253e997b44296b0db276`, and
system policy
`1cf958f9a7b8071ad41417b30c5afc2f91351665de2e802f24b3da1ef3868ce5`. The
rendered NetworkPolicy SHA-256 was
`c1e4faa896fa78a032a0c47674e83a15487b0e1f9c9120c1300ce36e7343dc9d`; the
candidate VAP validation expression SHA-256 was
`83b149f0222e345ac4b0eb1b29c5e984a6bcd60d217739df104d950a958ae1dd`.

The temporary VAP retained the candidate validation expression byte-for-byte;
only cluster ID, object names, and the matching admission username were changed
to isolate it from the canonical VAP. A temporary Deny binding bound the
candidate; its unique username match condition limited evaluation to the
run-specific impersonated probe identity, and requests targeted the owned
probe namespace. A readiness canary with the `/95` exclusion removed was
denied by that exact candidate VAP/binding before the matrix began.
The Kubernetes API then produced these results using server-side dry-run only:

| Case | Result |
| --- | --- |
| Exact renderer output with `::fffe:0:0/95` exception | Admitted |
| Old `::ffff:0:0/96` exception | Native API validation rejected it as not a strict subset of `::/0` |
| Listener port 65536 | Native API validation rejected it as outside 1–65535 |
| Named listener port | Candidate VAP denied it |
| Missing listener port | Candidate VAP denied it |
| Listener `endPort` range | Candidate VAP denied it |
| `/95` exclusion removed | Candidate VAP denied it |

All seven expected outcomes matched. The isolated candidate used an explicit
username match and an impersonated `system:masters` API identity solely to
exercise the CEL policy; this is API predicate evidence, not provider RBAC
acceptance. No Pod, image pull, or NetworkPolicy persisted. The final candidate
VAP status was generation/observedGeneration 1 with `typeChecking: {}`.

The candidate VAP, binding, and both owned probe namespaces were deleted with
Kubernetes `DeleteOptions` containing exact UID preconditions; each delete
returned HTTP 200, and follow-up GETs confirmed all four absent. The canonical
VAP and binding summaries compare byte-for-byte before and after. Evidence is
preserved outside the repository at
`/tmp/praetorium-owned-kube-evidence-20261017/current`; its SHA-256 manifest is
`/tmp/praetorium-owned-kube-evidence-20261017/SHA256SUMS`, hash
`ed5a500547a3ec53871e02ba0d91d7f5b407b6b3554fd9d9d86ff3b08abc917e`. The
candidate matrix report hash is
`da9094d95f7664a937cdc73fbb4c5ea287a83141723814b54b9b1b8b487241f9`; the
cleanup report hash is
`4fa6999e3af2ee40c1380bbf061d90a2e65ac2513b384d65bed02a56deb3b01e`. The
archive omits kubeconfig, auth, private environment, and key material.

## Build Worker secret-mount filesystem metadata

After the admission probe, the same owned v1.35.0 Kind cluster ran one
short-lived Pod using the digest-pinned public Node image
`docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`.
The archived Pod manifest (SHA-256
`e37120b14ccbe94900eefedc87c133bd414ccd26ad6abc6ab3b50a82ec61a969`) specifies
the restricted security profile, UID/GID/fsGroup 10001, a read-only Secret
projection with mode `0440`, an 8 Mi memory `emptyDir`, and a 2 Gi temporary
`emptyDir`. The kubelet confirmed the requested image digest; the Pod exited
0. The process output observed UID/GID/groups 10001 and printed only file
type, mode, ownership, symlink target metadata, and whether a read-only open
succeeded. It never read or logged Secret payload bytes.

The actual kubelet mount modes included writable shared roots: Secret
projection root `03777` (UID 0/GID 10001), memory `emptyDir` root `03777`,
and temporary `emptyDir` root `02777`. The projected `..data` target was
`02755` (UID 0/GID 10001): group/world readable and executable, but not
writable. The projected file was `0440` (UID 0/GID 10001), and UID/GID/group
10001 successfully opened it read-only. These observations are relevant to the Build Worker secret
preparation path: validation that requires private modes on source mount
directories cannot accept these raw Kubernetes mounts. This probe did not
execute `prepare-runtime-secrets`, copy material into the private runtime
directory, invoke the Build Worker constructor, or make a build request; those
remain separate acceptance gates.

The temporary Pod, benign Secret, and unique namespace were deleted with exact
UID preconditions. The API returned HTTP 200 for all three deletes, and
follow-up GETs confirmed the namespace, Pod, and Secret absent. The report SHA
is `c50180d8ffa7b3d021c0983d8aafeaa005fa9731d14bf6690d8c3395f94ed1ca`; the
metadata-only output SHA is
`5a4e9b9c3bbe1fe87e427697341c1c628de6f3254a71ed7ed6a921b208b05357`, and the
cleanup verification SHA is
`2daf994a6eb32d0cd3a55c1f731ce00a210a7f0a3a10a05c7b430df46daca5e6`.
These reports are in the private evidence archive's
`current/buildworker-secret-fs-20261017/`
directory (private absolute paths and credentials are excluded from the
archive index).

The IPv6 change was integrated after this live probe at main commit
`f3327c1edeb8e4aabd3c0d740a512e9db1b90a35`; the renderer, VAP, and system
policy file hashes at that commit are byte-identical to worker `522af7c`. The
probe used the worker checkout and did not rerun the integrated product
render/guard path, so that path still needs an integration recheck. The
secret-mount metadata probe is complete. The explicitly owned cluster is
retained for the separately bounded Build Worker private-copy/init-component
check; its completion is not implied here. Kind's default networking does not
certify NetworkPolicy packet enforcement, so CNI enforcement remains
**NOT_CHECKED**; no producer artifact or integrated T14 flow was used.
