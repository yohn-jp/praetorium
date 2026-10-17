# Disposable environment recheck

Status: **PASS for a generic local BuildKit and OCI registry round trip only.** It does not prove a Scriptorium composition, a Platform image, or T14 acceptance.

## Evidence cut

| Field | Value |
| --- | --- |
| Praetorium base | `main` at `788a7ad8905064536e01d3c7c3ed0c0904c6a255` |
| Worker | `worker/disposable-recheck-20261017` |
| Tested commit and tree | `cac3a4282ba3dd79a5a261fe54de0253921cabb7`; `7eaa5ba7a029a77fb281819c43309c0471d33519` |
| Tested launcher SHA-256 | `cabd3594212bd8432eb2ed4aada4c04bd8d925a1b418037df4092c4cee5cc1bb` |
| Producer source inspected | Scriptorium observer remained at frozen `fc4eea880ef895decf6161bf4f45cc958e9700b3`; read-only fetch observed docs head `eab0fad7c811aeedabe29fcd214598dc5207c178` |
| Host | Linux x86_64, UID 1000, Node `v24.21.0` |
| Cached tools | Podman `5.8.8`; BuildKit/buildctl `0.30.0`; netavark `1.17.2`; Kind `v0.31.0`; Kustomize `v5.8.1` |
| Pinned registry image | `docker.io/library/registry@sha256:5b12b22f21522fe69443079df04c0f3f42cb9977857f3c20404386652a6c6d8e` |
| Pinned Kind node image | `kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f` |

The producer `scripts/verify-oci.sh`, its OCI setup notes, and the new producer OCI evidence were read to compare environment setup only. No producer command was run, and no producer image, container, cache, worktree, or storage was read or changed.

## Rootless Podman setup

At the base revision, the fresh launcher failed during `podman info`, before pulling an image. Its private `PATH` placed `/run/current-system/sw/bin/newuidmap` ahead of the existing setuid wrapper because `/run/current-system/sw/bin` was also included through the pinned `unshare` binary's directory. Podman tried that non-setuid helper and the kernel rejected its UID-map write. A direct user/mount namespace probe succeeded. Host inspection confirmed the existing map wrappers are root-owned and setuid; the host files and permissions were left unchanged.

Putting the whole `/run/wrappers/bin` directory first fixed helper resolution but exposed unrelated setuid commands to all child processes, so that intermediate version was rejected in independent read-only review and its kept root was cleaned through the ownership-checked launcher. Putting only `newuidmap` and `newgidmap` symlinks on `PATH` was insufficient because Podman uses its `helper_binaries_dir` configuration for its own helpers. Limiting that setting to the private directory then reported the required `netavark` helper as missing.

The final launcher creates a mode-0700 helper directory below each owned root. It contains only symlinks to the validated root-owned, setuid, executable `newuidmap` and `newgidmap` wrappers. Podman's `[engine].helper_binaries_dir` searches that directory first and then the pinned Nix `netavark-1.17.2` binary directory. The child `PATH` starts with the private helper directory, then lists pinned tools and the ordinary system binary directory; it never includes `/run/wrappers/bin`. Cleanup validates the current user, exact helper links and root-owned targets before using the private Podman configuration.

From the exact clean tested commit above, `node --check scripts/local-disposable-environment.mjs` and `node scripts/local-disposable-environment.mjs --plan` passed. A fresh `node scripts/local-disposable-environment.mjs --run` then passed rootless Podman initialization, pulled and ran the pinned anonymous loopback registry, started BuildKit in an owned user/mount namespace, built an uncached scratch recipe, and fetched the result back from the registry. BuildKit metadata, the registry `Docker-Content-Digest` header, and SHA-256 of the manifest bytes matched; config and layer bytes also matched their descriptors.

| Smoke artifact | Value |
| --- | --- |
| Owned root | `/tmp/praetorium-owned-suVPfE` |
| Registry | `http://127.0.0.1:45179` (anonymous, loopback-only) |
| BuildKit socket | `unix:///tmp/praetorium-owned-suVPfE/runtime/buildkit.sock` |
| Recipe | `FROM scratch; COPY note.txt /note.txt` |
| Manifest digest | `sha256:c4c6ab22f11cf5cbb30e3578c59ddbaa87b963b7bc13576b1633ddf9b89ccb5b` |
| Config digest / bytes | `sha256:748fb2495ad3f677db2e5cb922ec105b3d550e8143516b3a08c9de144130b935` / 450 |
| Layer digest / bytes | `sha256:a052d354deb20c4c1e25f572e171fe58328d9a884a1069b3ce047ac93c37ed87` / 132 |
| Manifest bytes | 498 |
| Cleanup | `--run` exited 0 after the launcher stopped owned services and removed the exact root; a follow-up existence check confirmed the path was absent |

An earlier `--run --keep` smoke produced an owner inventory and a read-only T14 plan. Independent review then rejected its broad wrapper PATH; that root was removed with `node scripts/local-disposable-environment.mjs --cleanup /tmp/praetorium-owned-EuGuY2` (exit 0). Its inventory is no longer active and must not be reused. The plan had `effectsExecuted=false`, no validation errors, `buildkit-registry: NOT_CHECKED` (inventory is not runtime evidence), and the other six resources missing. No product category runner ran.

## Acceptance boundary

This verifies a generic local BuildKit-to-loopback-registry round trip on the current host. It did not use a Scriptorium artifact, approved Platform composition, Build Service admission, or producer S01-S05 contracts; no artifact digest was accepted for Platform. T14 remains blocked. This worker did not create a Kind cluster; a separate bounded worker owns the Kind check using separate storage and credentials.
