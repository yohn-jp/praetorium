#!/usr/bin/env bash
set -euo pipefail

# The operator selects a published GitHub Release. Resolve and check its
# immutable source *again* in each trusted job, before executing producer code.
source_dir="${1:?source checkout directory required}"
revision="${SCRIPTORIUM_REVISION:?source SHA required}"
tag="${SCRIPTORIUM_TAG:?published tag required}"
version="${SCRIPTORIUM_RELEASE_VERSION:?release version required}"

[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid source SHA" >&2; exit 1; }
[[ "$tag" =~ ^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z.-]+))?(\+([0-9A-Za-z.-]+))?$ ]] || {
  echo "Selected GitHub Release tag is not SemVer" >&2; exit 1;
}
[[ "${tag#v}" == "$version" ]] || { echo "Tag and SemVer version disagree" >&2; exit 1; }
[[ "$tag" != *".."* && "$tag" != *"//"* ]] || { echo "Invalid Git tag" >&2; exit 1; }

git -C "$source_dir" fetch --no-tags --depth=1 origin "refs/tags/$tag"
resolved="$(git -C "$source_dir" rev-parse 'FETCH_HEAD^{commit}')"
[[ "$resolved" == "$revision" ]] || { echo "Published tag changed after operator selection" >&2; exit 1; }
git -C "$source_dir" checkout --quiet --detach "$resolved"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$revision" ]]
[[ -z "$(git -C "$source_dir" status --porcelain)" ]]
[[ "$(git -C "$source_dir" remote get-url origin)" == "https://github.com/yohn-jp/scriptorium.git" ]]
