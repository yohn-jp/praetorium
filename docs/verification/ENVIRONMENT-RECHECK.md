# Disposable environment recheck

Status: **PASS for the generic local BuildKit and OCI registry substrate only.** This does not prove Scriptorium composition, a Platform image, or T14 acceptance.

## Evidence cut

| Field | Value |
| --- | --- |
| Praetorium base | `main` at `788a7ad8905064536e01d3c7c3ed0c0904c6a255` |
| Worker | `worker/disposable-recheck-20261017` |
| Source contract inspected | Scriptorium read-only observer at frozen `fc4eea880ef895decf6161bf4f45cc958e9700b3`; fetched producer documentation head `eab0fad7c811aeedabe29fcd214598dc5207c178` |
| Host | Linux x86_64, UID 1000, Node `v24.21.0` |
| Cached container tools | Podman `5.8.8`; BuildKit/buildctl `0.30.0`; Kind `v0.31.0`; Kustomize `v5.8.1` |
| Pinned registry image | `docker.io/library/registry@sha256:5b12b22f21522fe69443079df04c0f3f42cb9977857f3c20404386652a6c6d8e` |
| Pinned Kind node image | `kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f` |

The Scriptorium `scripts/verify-oci.sh`, its OCI setup notes, and the new producer OCI evidence were read to compare environment setup only. No producer command was run and no producer image, container, cache, worktree, or storage was read or changed.

## Rootless Podman path correction

The initial fresh launcher run at the base revision failed during `podman info`, before pulling the registry image. Its private `PATH` placed `/run/current-system/sw/bin` ahead of `/run/wrappers/bin`; `/run/current-system/sw/bin` was also present earlier as the directory of the pinned `unshare` binary. Podman therefore selected the non-setuid Nix store `newuidmap`, and the kernel rejected its UID-map write with `Operation not permitted`. The failed run removed its newly created private root.

A direct, single user/mount namespace probe succeeded, and host inspection found the existing root-owned setuid helper at `/run/wrappers/bin/newuidmap`. No host permissions or wrapper files were changed. The launcher now puts `/run/wrappers/bin` first, then its pinned tool directories, then `/run/current-system/sw/bin`. This keeps helper resolution inside the private child environment and leaves all Podman storage and configuration below the owned root.

After the correction, `node --check scripts/local-disposable-environment.mjs` and `node scripts/local-disposable-environment.mjs --plan` passed. A fresh `node scripts/local-disposable-environment.mjs --run --keep` completed the rootless Podman, loopback registry and BuildKit smoke build. BuildKit's manifest metadata digest matched the registry's `Docker-Content-Digest`; the manifest, config, and layer bytes were fetched back and their SHA-256 and size values checked independently.

| Smoke artifact | Value |
| --- | --- |
| Owned root | `/tmp/praetorium-owned-EuGuY2` |
| Registry | `http://127.0.0.1:44963` (anonymous and loopback-only) |
| BuildKit socket | `unix:///tmp/praetorium-owned-EuGuY2/runtime/buildkit.sock` |
| Recipe | `FROM scratch; COPY note.txt /note.txt` |
| Manifest digest | `sha256:de9e44161076a4ca618d9ad1765551558df0f08cc9365197ae2006b0646bf2ca` |
| Config digest / bytes | `sha256:e153b5f7ef89544aaf9777cdf95668ee745214d4fa19a560b9c9fdcabf821ede` / 450 |
| Layer digest / bytes | `sha256:64aea821c38d04983b287314e69d4fb119a4df8d20f3cb5b2e4b30dc662a050b` / 132 |
| Manifest bytes | 498 |
| Inventory SHA-256 | `1ef77e6c2544874a02a26cc396d3a67559160974839a77a98163e6e3385f724b` |
| Inventory expiry | `2026-10-17T14:47:23.350Z` |

The inventory at `/tmp/praetorium-owned-EuGuY2/acceptance-inventory.json` belongs to local UID 1000 and declares only `buildkit-registry` available. It expires at the time above. The `node scripts/verify-integration.mjs --plan --environment /tmp/praetorium-owned-EuGuY2/acceptance-inventory.json` command exited 2 with `effectsExecuted=false` and no validation errors: the BuildKit category is `NOT_CHECKED` because an ownership inventory is not runtime evidence, and the other six integration resources are missing. No product category runner was invoked.

The root and services remain alive pending the campaign coordinator's decision to reuse or clean them. The inventory's cleanup command validates the current UID, private `/tmp` root, ownership marker, and exact BuildKit socket before stopping services and removing only this owned root.

## Acceptance boundary

This run proves a local generic BuildKit-to-loopback-registry round trip on the current host. It does not use or verify a Scriptorium artifact, approved Platform composition, Build Service admission, or producer S01-S05 contracts. In particular, no artifact digest was accepted for Platform. The checked-in T14 plan therefore remains blocked; the generic BuildKit result must not be promoted to producer acceptance. This worker did not create a Kind cluster; a separate bounded worker owns that check with separate storage and credentials.
