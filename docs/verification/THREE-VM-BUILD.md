# Builder composition and cache evidence — 2026-10-20

Status: **Builder provider execution PASS; Control Plane admission and Runtime acceptance are not claimed.** This record covers actual rootless BuildKit output on the Builder VM. It does not mark the full G4 release or the three-VM production goal complete.

## Producer and execution path

The owner-staged canary policy selected the disposable repository ID `1423923158`, with no requested modules and the `small` profile. The current release-candidate manifest pins Scriptorium producer revision `008d5c429ec279a424cafd5b8c4cbee70a613b8e`, Runtime Base `sha256:93bb59a32e85d9891b1a4d4ece15845d93af677330935fce56e71b79e9875c52`, and BuildKit frontend `sha256:b0d99ef773188fa451f9aef1a03b52fb26871c152bb7eaebb1863c0cc44bf888`. The recipe, source, and lock digests were `sha256:d90d640bd9e0d232817d95e41e46787f5c2b8ff0918c2557655e32a2e678a`, `sha256:cf72b950c008c284f77d524f27eb3c2e4114ee0115fedb1cb53aba971e32d188`, and `sha256:873a93f452833cf963978904c1a3fdabb9dca1c85b2d27c592156bbd03e7ea9e`. Anonymous GHCR manifest HEAD checks for the Runtime Base and BuildKit frontend returned HTTP 200 and the expected digest for each.

The build ran inside the existing Ready Build Worker pod by calling the deployed `BuildKitProvider.execute` with the deployed `ScriptoriumBuildCandidateReceiptReader`, registry client, and mounted service credentials. The code path is [BuildKitProvider](../../plugins/buildkit/src/provider.ts) plus [ScriptoriumBuildCandidateReceiptReader](../../apps/build-worker/src/composition-artifacts.ts). It used controlled operator IDs and did not claim queue work, invoke the Control Plane queue, produce a Builder signature, write D1, admit an artifact, or call Runtime APIs. Candidate image tags were attempt-scoped in the configured private candidates repository; the Composition manifest was published to the configured compositions repository. No Runtime deployment or active writer was changed.

Two sequential provider calls used the exact same canonical input: `linux/amd64`, no requested or resolved modules, profile `small`, build key `sha256:ab7f61854d02116b004b1f59859cde0e8321f93ac04d1a68ef889a9981455753`.

| Attempt | Duration | Candidate digest | Composition digest | Provider receipt |
| --- | ---: | --- | --- | --- |
| `operator1423923158-20261020-repeat-01` | 5.491 s | `sha256:446a6a8a6703ebe54cc2ef924f71a885eabccf35b0397be6177cebb2f776ce99` | `sha256:988f9f58a69c145d934a26ac170d9ae0d6c39bb407579e001bf9c34f9f00e613` | Passed |
| `operator1423923158-20261020-repeat-02` | 3.597 s | Same digest | Same digest | Passed |

The owner-approved distinct catalog selection `publishing` was normalized with the repository's revision-bound Scriptorium catalog resolver. The resolver revision matched the catalog producer revision. It resolved only `publishing@0.1.0` (`sha256:88c436aa0b4537e221d662ddba0cd51a7fc156a15b96fa894603adff2fe7fc5c`). Its minimum requirements were 250m CPU, 256 MiB memory, and 512 MiB ephemeral storage; the selected `small` profile provides 500m CPU, 512 MiB, and 1 GiB. The canonical build key was `sha256:b7f8f205f5d0b13842a4b08f905a4b58317ee43794e6657b4d850c14bf58f275`.

That solve completed in 42.033 seconds and produced candidate `sha256:db70a5adae6579dfee4bccd851a6dbe0c4a0a1b930f398d31de9ff9af172fe96` and Composition blob `sha256:0a0ca10ddb53eea6c0a63f39b36840667311894fcf9cea17425311ae393bf979`. In addition to provider receipt validation, the existing `GhcrCandidateVerifier.verifyUnsignedCandidate` read back and verified the candidate image and Composition blob with the mounted registry credentials, including the `linux/amd64` platform and resolved module. The private GHCR packages returned HTTP 401 to anonymous read probes; authenticated service verification passed. The result remains unsigned and unadmitted.

## Cache and Builder resources

The BuildKit cache snapshot before the same-input pair contained 33 records totaling 2,465,317,017 bytes. After both calls it still had 33 records and the same total size, with no additions or removals; four existing records had updated `lastUsedAt` values. Both outputs had identical candidate and Composition digests, and the repeated solve was 1.894 seconds faster. Together these observations support same-key cache reuse. The worker intentionally exposes only bounded stage and percent progress, so it did not provide per-vertex hit counts.

The distinct `publishing` solve added four cache records and 275,466,902 bytes, bringing the snapshot to 37 records and 2,740,783,919 bytes. No record was in use after completion. No cache cleanup or GC configuration change was made.

The Builder had 4 vCPU and `MemTotal=12,242,912 KiB` (about 11.68 GiB), compared with the goal's stated 8 GiB target. Swap was zero. Root storage was 30 GiB total with 18 GiB free after the builds (42% used); `/var/lib/praetorium-buildkit` occupied 2.7 GiB. The host had recently booted, and this short measurement window should not be treated as a long-term workload profile.

BuildKit v0.34.0 ran as user `buildkit` under systemd with a 200% CPU quota, 4 GiB `MemoryMax`, and `TasksMax=4096`. The worker was rootless, enabled GC, and had `max-parallelism=1`; its config sets an 8 GiB maximum cache budget, 2 GiB minimum free space, and 5% reserved space. The live GC policies include a 512,000,000-byte / 48-hour rule for local, cachemount, and Git checkout records, followed by 8 GiB / 2 GiB-free-space policies.

Across the three solves, the BuildKit service cgroup high-water mark rose from 78,114,816 bytes before the pair to 117,743,616 bytes after the repeated empty composition, then to 1,266,696,192 bytes (about 1.18 GiB) after the distinct `publishing` solve. Its final current usage was 990,195,712 bytes. The cgroup reported zero `oom`, `oom_kill`, or `oom_group_kill` events. The post-run CPU counters showed eight throttling intervals totaling 157,519 microseconds.

Near the memory high-water mark, one sample reported 1,162,661,888 bytes charged to the cgroup: 103,116,800 bytes anonymous, 1,008,128,000 bytes file-backed, and 51,048,448 bytes kernel. The subsequent cgroup peak was 1,266,696,192 bytes. BuildKit process RSS/PSS samples topped out around 87 MiB / 82 MiB; the larger cgroup total includes file-backed cache and work performed below `buildkitd`. Host `MemAvailable` stayed above 11,352,780 KiB (about 10.82 GiB) during the measured window. These samples do not support increasing the 4 GiB service limit; they also do not establish a sustained upper bound for larger compositions.

The observed 12 GiB VM allocation differs from the stated 8 GiB goal target. This Builder task made no VM, service, GC, or cache changes. Reconcile the inventory separately; retain the current BuildKit limits pending longer observation and representative heavier selections.

## Admission and diagnostic gates

The two empty-input runs and the distinct `publishing` run demonstrate actual provider output and cache behavior. Control Plane signing, D1 admission, Runtime rollout, tenant health, and full G4 acceptance remain **BLOCKED / NOT_CHECKED** until the active-writer lifecycle gate is safe. These unsigned outputs are not deployable evidence by themselves.

One post-build read-only query through the operator's default kubeconfig targeted port `16443` and was refused. The parent confirmed the production API was Ready on explicit port `6443`, and the Build Worker pod was Ready there. This was a temporary operator kubeconfig mismatch, not evidence of a Runtime service outage.

The private, sanitized measurement record is stored outside this repository at `/data/praetorium/production/verification/buildkit-actual-builds-20261020.json`. No credentials, private IPs, cache descriptions, or raw BuildKit output were copied here. Source files were not changed; the frozen install and local builds of `@praetorium/contracts` and `@praetorium/scriptorium` succeeded to run the canonical catalog resolver.
