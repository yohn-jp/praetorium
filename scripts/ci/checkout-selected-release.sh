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

# An existing Git tag alone does not establish a published GitHub Release.
# Recheck publication independently; draft and deleted Releases fail closed.
release_json="$(mktemp)"
trap 'rm -f "$release_json"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --header 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/yohn-jp/scriptorium/releases/tags/$tag" \
  --output "$release_json"
node - "$release_json" "$tag" <<'NODE'
const fs = require("node:fs");
const release = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (release.draft !== false || !release.published_at ||
    release.tag_name !== process.argv[3] || !Number.isSafeInteger(release.id)) {
  console.error("GitHub Release is not published for the selected tag");
  process.exit(1);
}
NODE

git -C "$source_dir" fetch --no-tags --depth=1 origin "refs/tags/$tag"
resolved="$(git -C "$source_dir" rev-parse 'FETCH_HEAD^{commit}')"
[[ "$resolved" == "$revision" ]] || { echo "Published tag changed after operator selection" >&2; exit 1; }
git -C "$source_dir" checkout --quiet --detach "$resolved"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$revision" ]]
[[ -z "$(git -C "$source_dir" status --porcelain)" ]]
[[ "$(git -C "$source_dir" remote get-url origin)" == "https://github.com/yohn-jp/scriptorium.git" ]]
