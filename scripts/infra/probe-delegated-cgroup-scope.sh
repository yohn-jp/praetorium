#!/usr/bin/env bash

# Disposable check that a delegated systemd scope can move its direct process
# into a child and enable domain controllers without changing its parent.

set -Eeuo pipefail

readonly SAFE_PATH='/usr/sbin:/usr/bin:/sbin:/bin'

fail() {
  printf 'FAIL: delegated cgroup probe stopped at %s (guard line %s)\n' \
    "${STAGE:-preflight}" "${BASH_LINENO[0]:-unknown}" >&2
  exit 1
}

trap 'status=$?; printf "ERROR: delegated cgroup command failed at line %s (exit %s)\\n" "$LINENO" "$status" >&2' ERR

has_word() {
  local words=$1 expected=$2
  [[ " $words " == *" $expected "* ]]
}

if [[ ${1:-} != --inside ]]; then
  [[ $EUID == 0 && $(hostname -s) == manage ]] || fail
  scope_unit="praetorium-cgroup-delegation-probe-$$.scope"
  script_path=$(realpath -e -- "$0") || fail
  exec env -i PATH="$SAFE_PATH" TERM=dumb \
    systemd-run --scope --quiet --unit="$scope_unit" \
      --property=MemoryMax=256M --property=CPUQuota=50% --property=TasksMax=64 \
      --property='Delegate=cpu memory pids' -- \
      /usr/bin/bash "$script_path" --inside "$scope_unit"
fi

STAGE=scope-identity
[[ $# == 2 && $EUID == 0 ]] || fail
readonly SCOPE_UNIT=$2
[[ $SCOPE_UNIT =~ ^praetorium-cgroup-delegation-probe-[0-9]+\.scope$ ]] || fail

CGROUP_PATH=
while IFS=: read -r hierarchy _ path; do
  if [[ $hierarchy == 0 ]]; then
    CGROUP_PATH=$path
    break
  fi
done < /proc/self/cgroup
[[ $CGROUP_PATH == "/system.slice/$SCOPE_UNIT" ]] || fail

readonly SCOPE_DIR="/sys/fs/cgroup$CGROUP_PATH"
readonly PARENT_DIR=/sys/fs/cgroup/system.slice
[[ -d $SCOPE_DIR && ! -L $SCOPE_DIR ]] || fail
[[ $(realpath -e -- "$SCOPE_DIR") == "/sys/fs/cgroup/system.slice/$SCOPE_UNIT" ]] || fail
[[ -d $PARENT_DIR && ! -L $PARENT_DIR ]] || fail

STAGE=controller-availability
SCOPE_CONTROLLERS=$(cat "$SCOPE_DIR/cgroup.controllers")
for controller in cpu memory pids; do
  has_word "$SCOPE_CONTROLLERS" "$controller" || fail
done
SCOPE_SUBTREE_BEFORE=$(cat "$SCOPE_DIR/cgroup.subtree_control")

STAGE=parent-state-snapshot
PARENT_SUBTREE_BEFORE=$(cat "$PARENT_DIR/cgroup.subtree_control")

STAGE=child-create
readonly CHILD_DIR="$SCOPE_DIR/delegation-probe"
mkdir -- "$CHILD_DIR"

STAGE=move-scope-processes
scope_pids=()
while IFS= read -r pid; do
  [[ $pid =~ ^[1-9][0-9]*$ ]] || fail
  scope_pids+=("$pid")
done < "$SCOPE_DIR/cgroup.procs"
(( ${#scope_pids[@]} > 0 && ${#scope_pids[@]} <= 16 )) || fail
for pid in "${scope_pids[@]}"; do
  printf '%s\n' "$pid" > "$CHILD_DIR/cgroup.procs"
done
remaining_pids=()
while IFS= read -r pid; do
  [[ $pid =~ ^[1-9][0-9]*$ ]] || fail
  remaining_pids+=("$pid")
done < "$SCOPE_DIR/cgroup.procs"
(( ${#remaining_pids[@]} == 0 )) || fail

STAGE=enable-scope-subtree
printf '+cpu +memory +pids\n' > "$SCOPE_DIR/cgroup.subtree_control"
SCOPE_SUBTREE_AFTER=$(cat "$SCOPE_DIR/cgroup.subtree_control")
CHILD_CONTROLLERS=$(cat "$CHILD_DIR/cgroup.controllers")
for controller in cpu memory pids; do
  has_word "$SCOPE_SUBTREE_AFTER" "$controller" || fail
  has_word "$CHILD_CONTROLLERS" "$controller" || fail
done

STAGE=parent-state-verify
PARENT_SUBTREE_AFTER=$(cat "$PARENT_DIR/cgroup.subtree_control")
[[ $PARENT_SUBTREE_AFTER == "$PARENT_SUBTREE_BEFORE" ]] || fail

printf 'PASS: delegated scope moved %s direct process(es) to a child cgroup\n' "${#scope_pids[@]}"
printf 'scopeSubtreeBefore=%s\n' "${SCOPE_SUBTREE_BEFORE:-empty}"
printf 'scopeSubtreeControllers=cpu,memory,pids; childControllers=cpu,memory,pids\n'
printf 'parentSubtreeUnchanged=true; probeScopeWillBeRemovedOnExit=true\n'
