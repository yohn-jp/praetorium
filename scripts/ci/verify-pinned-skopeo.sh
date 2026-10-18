#!/usr/bin/env bash
set -euo pipefail

container_runtime="${CONTAINER_RUNTIME:-docker}"
image="${SKOPEO_IMAGE:?Missing required environment: SKOPEO_IMAGE}"
version_output="$("$container_runtime" run --rm "$image" --version)"
printf 'Pinned Skopeo output: %s\n' "$version_output"

if [[ ! "$version_output" =~ ^skopeo\ version\ 1\.21\.0(\ commit:\ [0-9a-f]{40})?$ ]]; then
  printf 'Pinned Skopeo image reported an unexpected version string.\n' >&2
  exit 1
fi
