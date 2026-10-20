#!/usr/bin/env bash

# Disposable, same-version K3s Server -> Agent continuity rehearsal.
#
# This script is intended to be reviewed before execution. It is only valid on
# the empty Management host and consumes the two already-staged, pinned inputs.
# K3s runs inside private mount, PID, cgroup, and network namespaces; /etc, /var, /run,
# /root, /home, /tmp, and /dev/shm are private tmpfs mounts. No production
# kubeconfig, token, datastore, API endpoint, host service, or host K3s path is
# mounted or passed into the test. The named network namespaces are connected
# only to each other by a private veth pair and have no default route.

set -Eeuo pipefail

readonly EXPECTED_K3S_SHA256='897acb21cca57d477a211102251a6591450ce767344a9faaa121a1007ca9fa9a'
readonly EXPECTED_PAUSE_SHA256='151f115213f522a5b9a43a257bd591bce3f362daca34329bb00d63a68953b3ce'
readonly EXPECTED_K3S_VERSION='v1.35.9+k3s1'
readonly SAFE_PATH='/usr/sbin:/usr/bin:/sbin:/bin'

capture_failure_diagnostics() {
  local diagnostic_path=${DIAGNOSTIC_OUTPUT:-}
  [[ -n $diagnostic_path && -f $diagnostic_path && ! -L $diagnostic_path ]] || return 0

  local log_path= process_state=unknown log_bytes=0 error_count=0 categories=none
  local category
  local -a detected_categories=()
  case ${STAGE:-unknown} in
    source-*) log_path=${SOURCE_LOG:-} ;;
    synthetic-snapshot) log_path=${WORK:-}/logs/snapshot.log ;;
    management-datastore-restore) log_path=${MGMT_RESTORE_LOG:-} ;;
    management-*|restored-*) log_path=${MGMT_LOG:-} ;;
    runtime-agent-start|agent-*) log_path=${AGENT_LOG:-} ;;
  esac

  case ${STAGE:-unknown} in
    source-*|synthetic-snapshot)
      if [[ ${SOURCE_SERVER_PID:-} =~ ^[1-9][0-9]*$ ]] && kill -0 "$SOURCE_SERVER_PID" 2>/dev/null; then
        process_state=running
      else
        process_state=exited
      fi
      ;;
    management-*)
      if [[ ${MGMT_SERVER_PID:-} =~ ^[1-9][0-9]*$ ]] && kill -0 "$MGMT_SERVER_PID" 2>/dev/null; then
        process_state=running
      else
        process_state=exited
      fi
      ;;
    runtime-agent-start|agent-*)
      if [[ ${RUNTIME_AGENT_PID:-} =~ ^[1-9][0-9]*$ ]] && kill -0 "$RUNTIME_AGENT_PID" 2>/dev/null; then
        process_state=running
      else
        process_state=exited
      fi
      ;;
  esac

  if [[ -n $log_path && -f $log_path ]]; then
    log_bytes=$(wc -c < "$log_path" 2>/dev/null || printf '0')
    error_count=$(grep -Eic 'level=(error|fatal)|(^|[^[:alpha:]])(fatal|panic)([^[:alpha:]]|$)|error:|failed to' \
      "$log_path" 2>/dev/null || true)
    if grep -Eiq 'x509|certificate|tls' "$log_path" 2>/dev/null; then detected_categories+=(tls); fi
    if grep -Eiq 'cgroup|controller|systemd' "$log_path" 2>/dev/null; then detected_categories+=(cgroup); fi
    if grep -Eiq 'permission denied|operation not permitted|read-only file system' "$log_path" 2>/dev/null; then detected_categories+=(permissions); fi
    if grep -Eiq 'bind:|address already in use|connection refused|listen tcp|network is unreachable|no route to host' "$log_path" 2>/dev/null; then detected_categories+=(network); fi
    if grep -Eiq 'containerd|container runtime|cri|runc' "$log_path" 2>/dev/null; then detected_categories+=(container-runtime); fi
    if grep -Eiq 'sqlite|etcd|datastore|snapshot' "$log_path" 2>/dev/null; then detected_categories+=(datastore); fi
    if grep -Eiq 'no such file|not found|exec format|unsupported' "$log_path" 2>/dev/null; then detected_categories+=(missing-input); fi
    if grep -Eiq 'level=(error|fatal)|(^|[^[:alpha:]])(fatal|panic)([^[:alpha:]]|$)|error:|failed to' "$log_path" 2>/dev/null; then detected_categories+=(error); fi
  fi
  if (( ${#detected_categories[@]} > 0 )); then
    categories=$(IFS=,; printf '%s' "${detected_categories[*]}")
  fi

  {
    printf 'failureStage=%s; processState=%s; logBytes=%s; errorLines=%s; categories=%s\n' \
      "${STAGE:-unknown}" "$process_state" "$log_bytes" "$error_count" "$categories"
    if [[ -n $log_path && -f $log_path ]]; then
      { grep -Ei 'level=(error|fatal)|(^|[^[:alpha:]])(fatal|panic)([^[:alpha:]]|$)|error:|failed to' \
          "$log_path" 2>/dev/null || true; } \
        | tail -n 20 \
        | sed -E \
          -e 's/(authorization[[:space:]]*:[[:space:]]*bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig' \
          -e 's/(--token(-file)?[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig' \
          -e 's/(token|password|secret|authorization|bearer|client-key-data|certificate-authority-data)([[:space:]"=:]+)[^[:space:],;\"]+/\1\2[REDACTED]/Ig' \
          -e 's/K10[0-9a-fA-F]{64}::[0-9a-fA-F]{16}/[REDACTED]/g' \
          -e 's/eyJ[[:alnum:]_-]{10,}\.[[:alnum:]_-]+\.[[:alnum:]_-]+/[REDACTED]/g' \
        | cut -c 1-512 \
        | sed 's/^/errorLog: /'
    fi
  } >> "$diagnostic_path" 2>/dev/null || true
}

fail() {
  capture_failure_diagnostics || true
  printf 'FAIL: isolated transition rehearsal stopped at %s (guard line %s)\n' \
    "${STAGE:-preflight}" "${BASH_LINENO[0]:-unknown}" >&2
  exit 1
}

trap 'status=$?; printf "ERROR: isolated transition command failed at line %s (exit %s)\\n" "$LINENO" "$status" >&2; capture_failure_diagnostics || true' ERR

sha256_file() {
  local hash_output
  hash_output=$(sha256sum -- "$1") || return
  printf '%s\n' "${hash_output%% *}"
}

findmnt_all_rows_equal() {
  local mount_path=$1 column=$2 expected=$3 rows row
  rows=$(findmnt -n -o "$column" --target "$mount_path") || return 1
  [[ -n $rows ]] || return 1
  while IFS= read -r row; do
    [[ $row == "$expected" ]] || return 1
  done <<< "$rows"
}

visible_fstype() {
  stat -f -c '%T' -- "$1"
}

visible_readonly_is() {
  local path=$1 expected=$2
  env PYTHONDONTWRITEBYTECODE=1 python3 -c \
    'import os,sys; actual=bool(os.statvfs(sys.argv[1]).f_flag & os.ST_RDONLY); expected=(sys.argv[2] == "true"); raise SystemExit(0 if actual == expected else 1)' \
    "$path" "$expected"
}

controller_additions_allowed() {
  local before=$1 after=$2 allowed=$3 controller
  for controller in $before; do
    [[ " $after " == *" $controller "* ]] || return 1
  done
  for controller in $after; do
    if [[ " $before " != *" $controller "* && " $allowed " != *" $controller "* ]]; then
      return 1
    fi
  done
}

if [[ ${1:-} != --inside && ${1:-} != --scope-cgroup && ${1:-} != --scope-launch ]]; then
  STAGE=outer-preflight
  if [[ $# == 2 && $1 == --full ]]; then
    MODE_FLAG=$1
    PREFLIGHT_ONLY=false
    staging_argument=$2
  elif [[ $# == 2 && $1 == --preflight-only ]]; then
    MODE_FLAG=$1
    PREFLIGHT_ONLY=true
    staging_argument=$2
  else
    fail
  fi
  [[ $EUID == 0 ]] || fail
  [[ $(hostname -s) == manage ]] || fail
  staging_dir=$(realpath -e -- "$staging_argument") || fail
  script_path=$(realpath -e -- "$0") || fail
  [[ $staging_dir == /tmp/praetorium-k3s-transition.* ]] || fail
  [[ -d $staging_dir && $(stat -c '%u:%a' -- "$staging_dir") == 0:700 ]] || fail
  readonly HOST_DIAGNOSTICS="$staging_dir/failure-diagnostics.log"
  if [[ $PREFLIGHT_ONLY == false ]]; then
    [[ -f $staging_dir/k3s && ! -L $staging_dir/k3s ]] || fail
    [[ -f $staging_dir/pause.oci.tar && ! -L $staging_dir/pause.oci.tar ]] || fail
    [[ $(sha256_file "$staging_dir/k3s") == "$EXPECTED_K3S_SHA256" ]] || fail
    [[ $(sha256_file "$staging_dir/pause.oci.tar") == "$EXPECTED_PAUSE_SHA256" ]] || fail
    if [[ -e $HOST_DIAGNOSTICS || -L $HOST_DIAGNOSTICS ]]; then
      [[ -f $HOST_DIAGNOSTICS && ! -L $HOST_DIAGNOSTICS && $(stat -c '%u:%a' -- "$HOST_DIAGNOSTICS") == 0:600 ]] || fail
    else
      (umask 077; set -o noclobber; : > "$HOST_DIAGNOSTICS") || fail
      chmod 0600 -- "$HOST_DIAGNOSTICS" || fail
    fi
  fi
  parent_mount_ns=$(readlink /proc/self/ns/mnt)
  parent_net_ns=$(readlink /proc/self/ns/net)
  parent_pid_ns=$(readlink /proc/self/ns/pid)
  parent_cgroup_ns=$(readlink /proc/self/ns/cgroup)
  readonly SYSTEM_SLICE_CGROUP=/sys/fs/cgroup/system.slice
  [[ -f $SYSTEM_SLICE_CGROUP/cgroup.subtree_control ]] || fail
  PARENT_SUBTREE_BEFORE=$(cat "$SYSTEM_SLICE_CGROUP/cgroup.subtree_control") || fail

  # Start inside a bounded systemd scope. Enter its cgroup namespace before
  # moving the direct scope processes so the namespace root remains the scope.
  scope_unit="praetorium-k3s-transition-rehearsal-$$"
  if scope_output=$(env -i PATH="$SAFE_PATH" TERM=dumb \
    systemd-run --scope --quiet --unit="$scope_unit" \
      --property=MemoryMax=3G --property=CPUQuota=100% --property=TasksMax=4096 \
      --property='Delegate=cpu memory pids' -- \
      /usr/bin/bash "$script_path" --scope-launch "$scope_unit.scope" "$script_path" \
        "$staging_dir" "$MODE_FLAG" "$parent_mount_ns" "$parent_net_ns" \
        "$parent_pid_ns" "$parent_cgroup_ns" "$PARENT_SUBTREE_BEFORE"); then
    scope_status=0
  else
    scope_status=$?
  fi
  [[ -z $scope_output ]] || printf '%s\n' "$scope_output"
  PARENT_SUBTREE_AFTER=$(cat "$SYSTEM_SLICE_CGROUP/cgroup.subtree_control") || fail
  if ! controller_additions_allowed "$PARENT_SUBTREE_BEFORE" "$PARENT_SUBTREE_AFTER" 'cpu memory pids'; then
    STAGE=parent-scope-controller-change
    printf 'parentControllerSnapshot: before=%s; after=%s\n' \
      "${PARENT_SUBTREE_BEFORE:-empty}" "${PARENT_SUBTREE_AFTER:-empty}" >&2
    fail
  fi
  printf 'systemSliceAfterScopeExit: subtreeBeforeLaunch=%s; subtreeAfterExit=%s\n' \
    "${PARENT_SUBTREE_BEFORE:-empty}" "${PARENT_SUBTREE_AFTER:-empty}"
  [[ $scope_status == 0 ]] || exit "$scope_status"
  exit 0
fi

if [[ ${1:-} == --scope-launch ]]; then
  STAGE=scope-launch-identity
  [[ $# == 10 && $EUID == 0 && $(hostname -s) == manage ]] || fail
  readonly SCOPE_UNIT=$2
  readonly SCRIPT_PATH=$3
  readonly STAGING_DIR=$4
  readonly MODE_FLAG=$5
  if [[ $MODE_FLAG == --full ]]; then
    readonly PREFLIGHT_ONLY=false
  elif [[ $MODE_FLAG == --preflight-only ]]; then
    readonly PREFLIGHT_ONLY=true
  else
    fail
  fi
  readonly PARENT_MOUNT_NS=$6
  readonly PARENT_NET_NS=$7
  readonly PARENT_PID_NS=$8
  readonly PARENT_CGROUP_NS=$9
  readonly PARENT_SUBTREE_BEFORE=${10}
  [[ $SCOPE_UNIT =~ ^praetorium-k3s-transition-rehearsal-[0-9]+\.scope$ ]] || fail
  [[ $PREFLIGHT_ONLY == true || $PREFLIGHT_ONLY == false ]] || fail
  [[ $(realpath -e -- "$SCRIPT_PATH") == "$SCRIPT_PATH" ]] || fail

  CGROUP_HIERARCHY=
  CGROUP_PATH=
  while IFS=: read -r CGROUP_HIERARCHY _ CGROUP_PATH; do
    [[ $CGROUP_HIERARCHY == 0 ]] && break
  done < /proc/self/cgroup
  [[ $CGROUP_HIERARCHY == 0 && $CGROUP_PATH == "/system.slice/$SCOPE_UNIT" ]] || fail
  readonly SCOPE_HOST_CGROUP="/sys/fs/cgroup/system.slice/$SCOPE_UNIT"
  [[ -d $SCOPE_HOST_CGROUP && ! -L $SCOPE_HOST_CGROUP ]] || fail
  [[ $(realpath -e -- "$SCOPE_HOST_CGROUP") == "$SCOPE_HOST_CGROUP" ]] || fail

  STAGE=scope-activation-snapshot
  PARENT_SUBTREE_AFTER_SCOPE=$(cat /sys/fs/cgroup/system.slice/cgroup.subtree_control) || fail
  SCOPE_SUBTREE_BEFORE=$(cat "$SCOPE_HOST_CGROUP/cgroup.subtree_control") || fail
  if ! controller_additions_allowed "$PARENT_SUBTREE_BEFORE" "$PARENT_SUBTREE_AFTER_SCOPE" 'cpu memory pids'; then
    printf 'scopeActivationSnapshot: parentBefore=%s; parentAfter=%s; scopeBefore=%s\n' \
      "${PARENT_SUBTREE_BEFORE:-empty}" "${PARENT_SUBTREE_AFTER_SCOPE:-empty}" \
      "${SCOPE_SUBTREE_BEFORE:-empty}" >&2
    fail
  fi

  STAGE=scope-isolated-run
  if /usr/bin/env -i PATH="$SAFE_PATH" TERM=dumb /usr/bin/unshare --mount --cgroup --fork -- \
    /usr/bin/env -i PATH="$SAFE_PATH" TERM=dumb /usr/bin/bash "$SCRIPT_PATH" --scope-cgroup \
      "$SCOPE_UNIT" "$STAGING_DIR" "$MODE_FLAG" "$PARENT_MOUNT_NS" \
      "$PARENT_NET_NS" "$PARENT_PID_NS" "$PARENT_CGROUP_NS" "$SCOPE_SUBTREE_BEFORE"; then
    isolated_status=0
  else
    isolated_status=$?
  fi

  STAGE=scope-after-snapshot
  PARENT_SUBTREE_AFTER_INNER=$(cat /sys/fs/cgroup/system.slice/cgroup.subtree_control) || fail
  SCOPE_SUBTREE_AFTER=$(cat "$SCOPE_HOST_CGROUP/cgroup.subtree_control") || fail
  [[ $PARENT_SUBTREE_AFTER_INNER == "$PARENT_SUBTREE_AFTER_SCOPE" ]] || fail
  controller_additions_allowed "$SCOPE_SUBTREE_BEFORE" "$SCOPE_SUBTREE_AFTER" 'cpu memory pids' || fail
  CGROUP_HIERARCHY=
  CGROUP_PATH=
  while IFS=: read -r CGROUP_HIERARCHY _ CGROUP_PATH; do
    [[ $CGROUP_HIERARCHY == 0 ]] && break
  done < /proc/self/cgroup
  [[ $CGROUP_HIERARCHY == 0 && $CGROUP_PATH == "/system.slice/$SCOPE_UNIT/praetorium-rehearsal" ]] || fail
  [[ -z $(cat "$SCOPE_HOST_CGROUP/cgroup.procs") ]] || fail
  CHILD_CONTROLLERS_AFTER=$(cat "$SCOPE_HOST_CGROUP/praetorium-rehearsal/cgroup.controllers") || fail
  for controller in cpu memory pids; do
    [[ " $CHILD_CONTROLLERS_AFTER " == *" $controller "* ]] || fail
  done
  printf 'systemdScopeActivation: subtreeBeforeLaunch=%s; subtreeAfterScopeCreated=%s\n' \
    "${PARENT_SUBTREE_BEFORE:-empty}" "${PARENT_SUBTREE_AFTER_SCOPE:-empty}"
  printf 'scopeControllerChange: before=%s; after=%s\n' \
    "${SCOPE_SUBTREE_BEFORE:-empty}" "${SCOPE_SUBTREE_AFTER:-empty}"
  printf 'systemSliceDuringInner: before=%s; after=%s\n' \
    "${PARENT_SUBTREE_AFTER_SCOPE:-empty}" "${PARENT_SUBTREE_AFTER_INNER:-empty}"
  [[ $isolated_status == 0 ]] || exit "$isolated_status"
  exit 0
fi

if [[ ${1:-} == --scope-cgroup ]]; then
  STAGE=scope-cgroup-identity
  [[ $# == 9 && $EUID == 0 && $(hostname -s) == manage ]] || fail
  readonly SCOPE_UNIT=$2
  readonly STAGING_DIR=$3
  readonly MODE_FLAG=$4
  if [[ $MODE_FLAG == --full ]]; then
    readonly PREFLIGHT_ONLY=false
  elif [[ $MODE_FLAG == --preflight-only ]]; then
    readonly PREFLIGHT_ONLY=true
  else
    fail
  fi
  readonly PARENT_MOUNT_NS=$5
  readonly PARENT_NET_NS=$6
  readonly PARENT_PID_NS=$7
  readonly PARENT_CGROUP_NS=$8
  readonly SCOPE_SUBTREE_BEFORE_EXPECTED=$9
  [[ $SCOPE_UNIT =~ ^praetorium-k3s-transition-rehearsal-[0-9]+\.scope$ ]] || fail
  [[ $PREFLIGHT_ONLY == true || $PREFLIGHT_ONLY == false ]] || fail
  [[ $(readlink /proc/self/ns/cgroup) != "$PARENT_CGROUP_NS" ]] || fail
  CGROUP_HIERARCHY=
  CGROUP_PATH=
  while IFS=: read -r CGROUP_HIERARCHY _ CGROUP_PATH; do
    [[ $CGROUP_HIERARCHY == 0 ]] && break
  done < /proc/self/cgroup
  [[ $CGROUP_HIERARCHY == 0 && $CGROUP_PATH == / ]] || fail

  # The new mount namespace contains a cgroup2 mount rooted at this scope.
  # All cgroup writes below are confined to this transient scope.
  STAGE=scope-cgroup-mount
  mount --make-rprivate /
  umount /sys/fs/cgroup
  mount -t cgroup2 -o nsdelegate cgroup2 /sys/fs/cgroup
  [[ $(visible_fstype /sys/fs/cgroup) == cgroup2fs ]] || fail
  visible_readonly_is /sys/fs/cgroup false || fail
  [[ $(cat /sys/fs/cgroup/memory.max) == 3221225472 ]] || fail
  [[ $(cat /sys/fs/cgroup/pids.max) == 4096 ]] || fail
  read -r scope_cpu_quota scope_cpu_period < /sys/fs/cgroup/cpu.max
  [[ $scope_cpu_quota == 100000 && $scope_cpu_period == 100000 ]] || fail

  STAGE=scope-controller-availability
  SCOPE_CONTROLLERS=$(cat /sys/fs/cgroup/cgroup.controllers)
  for controller in cpu memory pids; do
    [[ " $SCOPE_CONTROLLERS " == *" $controller "* ]] || fail
  done
  SCOPE_SUBTREE_BEFORE=$(cat /sys/fs/cgroup/cgroup.subtree_control)
  [[ $SCOPE_SUBTREE_BEFORE == "$SCOPE_SUBTREE_BEFORE_EXPECTED" ]] || fail
  readonly CHILD_CGROUP=/sys/fs/cgroup/praetorium-rehearsal
  STAGE=scope-child-create
  mkdir -- "$CHILD_CGROUP"

  STAGE=scope-process-move
  scope_pids=()
  while IFS= read -r pid; do
    [[ $pid =~ ^[1-9][0-9]*$ ]] || fail
    scope_pids+=("$pid")
  done < /sys/fs/cgroup/cgroup.procs
  (( ${#scope_pids[@]} > 0 && ${#scope_pids[@]} <= 16 )) || fail
  for pid in "${scope_pids[@]}"; do
    printf '%s\n' "$pid" > "$CHILD_CGROUP/cgroup.procs"
  done
  remaining_scope_pids=()
  while IFS= read -r pid; do
    [[ $pid =~ ^[1-9][0-9]*$ ]] || fail
    remaining_scope_pids+=("$pid")
  done < /sys/fs/cgroup/cgroup.procs
  (( ${#remaining_scope_pids[@]} == 0 )) || fail

  STAGE=scope-subtree-enable
  printf '+cpu +memory +pids\n' > /sys/fs/cgroup/cgroup.subtree_control
  SCOPE_SUBTREE_AFTER=$(cat /sys/fs/cgroup/cgroup.subtree_control)
  CHILD_CONTROLLERS=$(cat "$CHILD_CGROUP/cgroup.controllers")
  for controller in cpu memory pids; do
    [[ " $SCOPE_SUBTREE_AFTER " == *" $controller "* ]] || fail
    [[ " $CHILD_CONTROLLERS " == *" $controller "* ]] || fail
  done
  [[ -z $(cat /sys/fs/cgroup/cgroup.procs) ]] || fail

  script_path=$(realpath -e -- "$0") || fail
  exec /usr/bin/unshare --mount --net --pid --fork --mount-proc -- \
    /usr/bin/env -i PATH="$SAFE_PATH" TERM=dumb /usr/bin/bash "$script_path" --inside \
      "$STAGING_DIR" "$MODE_FLAG" "$PARENT_MOUNT_NS" "$PARENT_NET_NS" \
      "$PARENT_PID_NS" "$PARENT_CGROUP_NS"
fi

STAGE=namespace-guard
[[ $# == 7 && $EUID == 0 && $1 == --inside ]] || fail
[[ $$ == 1 ]] || fail
readonly STAGING_DIR=$2
readonly MODE_FLAG=$3
if [[ $MODE_FLAG == --full ]]; then
  readonly PREFLIGHT_ONLY=false
elif [[ $MODE_FLAG == --preflight-only ]]; then
  readonly PREFLIGHT_ONLY=true
else
  fail
fi
readonly PARENT_MOUNT_NS=$4
readonly PARENT_NET_NS=$5
readonly PARENT_PID_NS=$6
readonly PARENT_CGROUP_NS=$7
[[ $PREFLIGHT_ONLY == true || $PREFLIGHT_ONLY == false ]] || fail
[[ $(hostname -s) == manage ]] || fail
[[ $(readlink /proc/self/ns/mnt) != "$PARENT_MOUNT_NS" ]] || fail
[[ $(readlink /proc/self/ns/net) != "$PARENT_NET_NS" ]] || fail
[[ $(readlink /proc/self/ns/pid) != "$PARENT_PID_NS" ]] || fail
[[ $(readlink /proc/self/ns/cgroup) != "$PARENT_CGROUP_NS" ]] || fail

mount --make-rprivate /
mount --bind / /
mount -o remount,bind,ro /
if [[ $PREFLIGHT_ONLY == false ]]; then
  # Recreate this bind after the private root bind so a non-recursive root
  # bind cannot cover the staged inputs mounted below /tmp.
  STAGE=stage-input-bind
  mount --bind "$STAGING_DIR" /mnt
  mount -o remount,bind,ro /mnt
  STAGE=stage-input-readonly
  visible_readonly_is /mnt true || fail
  STAGE=stage-input-digest
  [[ $(sha256_file /mnt/k3s) == "$EXPECTED_K3S_SHA256" ]] || fail
  [[ $(sha256_file /mnt/pause.oci.tar) == "$EXPECTED_PAUSE_SHA256" ]] || fail
  STAGE=failure-diagnostics-mount
  [[ -f $STAGING_DIR/failure-diagnostics.log && ! -L $STAGING_DIR/failure-diagnostics.log ]] || fail
  [[ $(stat -c '%u:%a' -- "$STAGING_DIR/failure-diagnostics.log") == 0:600 ]] || fail
  mount -t tmpfs -o size=1m,mode=0700,nosuid,nodev tmpfs /opt
  : > /opt/failure-diagnostics.log
  chmod 0600 /opt/failure-diagnostics.log
  mount --bind "$STAGING_DIR/failure-diagnostics.log" /opt/failure-diagnostics.log
  mount -o remount,bind,rw /opt/failure-diagnostics.log
  visible_readonly_is /opt/failure-diagnostics.log false || fail
  DIAGNOSTIC_OUTPUT=/opt/failure-diagnostics.log
fi

# Mask persistent/default K3s and kubeconfig locations before invoking K3s.
mount -t tmpfs -o size=3g,mode=1777,nosuid,nodev tmpfs /tmp
mount -t tmpfs -o size=512m,mode=0755,nosuid,nodev tmpfs /var
mount -t tmpfs -o size=128m,mode=0755,nosuid,nodev tmpfs /run
mount -t tmpfs -o size=32m,mode=0755,nosuid,nodev tmpfs /etc
mount -t tmpfs -o size=64m,mode=0700,nosuid,nodev tmpfs /root
mount -t tmpfs -o size=64m,mode=0755,nosuid,nodev tmpfs /home
cd /
mount -t tmpfs -o size=16m,mode=0755,nosuid,noexec tmpfs /dev
mkdir -p /dev/pts /dev/shm
mknod -m 0666 /dev/null c 1 3
mknod -m 0666 /dev/zero c 1 5
mknod -m 0666 /dev/full c 1 7
mknod -m 0666 /dev/random c 1 8
mknod -m 0666 /dev/urandom c 1 9
mknod -m 0666 /dev/tty c 5 0
mount -t devpts -o newinstance,ptmxmode=0666,mode=0620,gid=5 devpts /dev/pts
ln -s pts/ptmx /dev/ptmx
ln -s /proc/self/fd /dev/fd
ln -s /proc/self/fd/0 /dev/stdin
ln -s /proc/self/fd/1 /dev/stdout
ln -s /proc/self/fd/2 /dev/stderr
mount -t tmpfs -o size=64m,mode=1777,nosuid,nodev tmpfs /dev/shm

# Give the delegated rehearsal scope its own cgroupfs root; no test cgroup can
# be created beside the scope or below an unrelated host service.
mount --make-rprivate /sys
umount /sys/fs/cgroup
mount --bind /sys /sys
mount -o remount,bind,ro /sys
mount -t cgroup2 -o nsdelegate cgroup2 /sys/fs/cgroup

# K3s networking is confined to the private netns. Keep sysctl writes disabled
# as an additional guard against changes outside that network namespace.
mount --bind /proc/sys /proc/sys
mount -o remount,bind,ro /proc/sys

mkdir -p /run/netns /etc/rancher/k3s /etc/rancher/node /root /home/rehearsal
ln -s /run /var/run
printf '127.0.0.1 localhost\n' > /etc/hosts
printf 'praetorium-rehearsal\n' > /etc/hostname
printf 'nameserver 127.0.0.1\n' > /etc/resolv.conf

readonly WORK=/tmp/praetorium-k3s-transition
readonly K3S_BIN=$WORK/bin/k3s
readonly HOME_PRIVATE=$WORK/home
readonly SOURCE_DATA=$WORK/data/runtime
readonly MGMT_DATA=$WORK/data/management
readonly SOURCE_CONFIG=$WORK/config/runtime.kubeconfig
readonly MGMT_CONFIG=$WORK/config/management.kubeconfig
readonly POD_MANIFEST=$WORK/transition-probe.yaml
readonly SOURCE_LOG=$WORK/logs/runtime-server.log
readonly MGMT_RESTORE_LOG=$WORK/logs/management-restore.log
readonly MGMT_LOG=$WORK/logs/management-server.log
readonly AGENT_LOG=$WORK/logs/runtime-agent.log
readonly EMPTYDIR_MARKER_NAME='.praetorium-transition-marker'
readonly EMPTYDIR_MARKER_CONTENT='praetorium-disposable-transition-rehearsal-v1'

if [[ $PREFLIGHT_ONLY == false ]]; then
  mkdir -p "$WORK/bin" "$WORK/home" "$WORK/data/runtime" "$WORK/data/management" \
    "$WORK/config" "$WORK/logs" "$HOME_PRIVATE"
  chmod 0700 "$WORK" "$WORK/home" "$HOME_PRIVATE" "$WORK/data" "$WORK/data/runtime" "$WORK/data/management" "$WORK/config" "$WORK/logs"
  install -m 0500 /mnt/k3s "$K3S_BIN"
fi

for mount_path in /tmp /var /run /etc /root /home /dev/shm; do
  STAGE="mount-guard-$mount_path-fstype"
  [[ $(visible_fstype "$mount_path") == tmpfs ]] || fail
done
STAGE=mount-guard-root-readonly
visible_readonly_is / true || fail
STAGE=mount-guard-root-private
findmnt_all_rows_equal / PROPAGATION private || fail
STAGE=mount-guard-dev-tmpfs
[[ $(visible_fstype /dev) == tmpfs ]] || fail
STAGE=mount-guard-cgroup2
[[ $(visible_fstype /sys/fs/cgroup) == cgroup2fs ]] || fail
STAGE=mount-guard-cgroup2-readwrite
visible_readonly_is /sys/fs/cgroup false || fail
STAGE=mount-guard-sys-readonly
visible_readonly_is /sys true || fail
STAGE=mount-guard-sys-private
findmnt_all_rows_equal /sys PROPAGATION private || fail
STAGE=mount-guard-proc-sys-readonly
visible_readonly_is /proc/sys true || fail
STAGE=namespace-guard
CGROUP_HIERARCHY=
CGROUP_CONTROLLIST=
CGROUP_PATH=
while IFS=: read -r CGROUP_HIERARCHY CGROUP_CONTROLLIST CGROUP_PATH; do
  [[ $CGROUP_HIERARCHY == 0 ]] && break
done < /proc/self/cgroup
[[ $CGROUP_HIERARCHY == 0 && $CGROUP_PATH == /praetorium-rehearsal ]] || fail
[[ $(cat /sys/fs/cgroup/memory.max) == 3221225472 ]] || fail
[[ $(cat /sys/fs/cgroup/pids.max) == 4096 ]] || fail
CGROUP_CONTROLLERS=$(cat /sys/fs/cgroup/cgroup.controllers)
CGROUP_SUBTREE_CONTROLLERS=$(cat /sys/fs/cgroup/cgroup.subtree_control)
for controller in cpu memory pids; do
  STAGE="cgroup-controller-$controller"
  [[ " $CGROUP_CONTROLLERS " == *" $controller "* ]] || fail
  STAGE="cgroup-subtree-controller-$controller"
  [[ " $CGROUP_SUBTREE_CONTROLLERS " == *" $controller "* ]] || fail
done
read -r CPU_QUOTA CPU_PERIOD < /sys/fs/cgroup/cpu.max
[[ $CPU_QUOTA == 100000 && $CPU_PERIOD == 100000 ]] || fail
[[ ! -e /etc/rancher/k3s/k3s.yaml && ! -e /etc/rancher/k3s/config.yaml ]] || fail
[[ ! -e /root/.kube/config && ! -e /root/.rancher/k3s ]] || fail
if ip route show default | grep -q .; then
  fail
fi

if [[ $PREFLIGHT_ONLY == true ]]; then
  printf 'PREFLIGHT PASS: no K3s command was invoked\n'
  printf 'namespaces: mnt=%s net=%s pid=%s cgroup=%s; cgroupPath=%s\n' \
    "$(readlink /proc/self/ns/mnt)" "$(readlink /proc/self/ns/net)" \
    "$(readlink /proc/self/ns/pid)" "$(readlink /proc/self/ns/cgroup)" "$CGROUP_PATH"
  printf 'mountGuards: root=private,ro; sys=private,ro; procSys=ro; cgroup2=rw; hostDevicesMasked=true\n'
  printf 'scopeLimits: memory.max=%s; cpu.max=%s; pids.max=%s; controllers=%s; subtree=%s\n' \
    "$(cat /sys/fs/cgroup/memory.max)" "$(cat /sys/fs/cgroup/cpu.max)" \
    "$(cat /sys/fs/cgroup/pids.max)" "$CGROUP_CONTROLLERS" "$CGROUP_SUBTREE_CONTROLLERS"
  printf 'networkGuard: defaultRoute=false; stagedInputs=read-only\n'
  exit 0
fi

STAGE=network-isolation
ip netns add pr-mgmt
ip netns add pr-runtime
ip link add pr-m0 type veth peer name pr-r0
ip link set pr-m0 netns pr-mgmt
ip link set pr-r0 netns pr-runtime
ip -n pr-mgmt link set lo up
ip -n pr-runtime link set lo up
ip -n pr-mgmt address add 10.253.40.1/30 dev pr-m0
ip -n pr-runtime address add 10.253.40.2/30 dev pr-r0
ip -n pr-mgmt link set pr-m0 up
ip -n pr-runtime link set pr-r0 up
if ip -n pr-mgmt route show default | grep -q . || ip -n pr-runtime route show default | grep -q .; then
  fail
fi
ip netns exec pr-mgmt ping -c 1 -W 1 10.253.40.2 >/dev/null 2>&1 || fail
ip netns exec pr-runtime ping -c 1 -W 1 10.253.40.1 >/dev/null 2>&1 || fail

run_k3s() {
  local namespace=$1 data_dir=$2 kubeconfig=$3
  shift 3
  ip netns exec "$namespace" env -i PATH="$SAFE_PATH" HOME="$HOME_PRIVATE" \
    K3S_DATA_DIR="$data_dir" KUBECONFIG="$kubeconfig" \
    "$K3S_BIN" "$@"
}

start_k3s() {
  local namespace=$1 data_dir=$2 kubeconfig=$3 log_path=$4
  shift 4
  ip netns exec "$namespace" env -i PATH="$SAFE_PATH" HOME="$HOME_PRIVATE" \
    K3S_DATA_DIR="$data_dir" KUBECONFIG="$kubeconfig" \
    "$K3S_BIN" "$@" >"$log_path" 2>&1 &
  STARTED_PID=$!
}

run_kubectl() {
  local namespace=$1 data_dir=$2 kubeconfig=$3 endpoint=$4
  shift 4
  run_k3s "$namespace" "$data_dir" "$kubeconfig" kubectl \
    --kubeconfig "$kubeconfig" --server "https://$endpoint:6443" "$@"
}

wait_for_api() {
  local namespace=$1 data_dir=$2 kubeconfig=$3 endpoint=$4
  local attempt
  for attempt in $(seq 1 90); do
    if run_kubectl "$namespace" "$data_dir" "$kubeconfig" "$endpoint" get --raw=/readyz 2>/dev/null | grep -qx ok; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_socket() {
  local socket=$1 attempt
  for attempt in $(seq 1 90); do
    [[ -S $socket ]] && return 0
    sleep 2
  done
  return 1
}

container_identity() {
  run_kubectl "$1" "$2" "$3" "$4" get pod transition-probe -n default \
    -o 'jsonpath={.metadata.uid}{"\t"}{.status.containerStatuses[0].containerID}{"\t"}{.status.containerStatuses[0].state.running.startedAt}'
}

task_pid() {
  local namespace=$1 data_dir=$2 container_id=$3 table
  table=$(run_k3s "$namespace" "$data_dir" "$WORK/no-kubeconfig" ctr \
    --address "$data_dir/agent/containerd/containerd.sock" --namespace k8s.io tasks list)
  local task_id task_process_id task_status
  while read -r task_id task_process_id task_status; do
    if [[ $task_id == "$container_id" && $task_process_id =~ ^[1-9][0-9]*$ ]]; then
      printf '%s\n' "$task_process_id"
      return 0
    fi
  done <<<"$table"
  return 1
}

emptydir_marker_matches() {
  local task=$1 marker="/proc/$1/root/data/$EMPTYDIR_MARKER_NAME"
  [[ $task =~ ^[1-9][0-9]*$ && -f $marker ]] || return 1
  [[ $(cat -- "$marker") == "$EMPTYDIR_MARKER_CONTENT" ]]
}

lease_renew_time() {
  run_kubectl "$1" "$2" "$3" "$4" get lease runtime-rehearsal \
    -n kube-node-lease -o 'jsonpath={.spec.renewTime}'
}

STAGE=version-check
mkdir -p "$WORK/data/version"
VERSION_OUTPUT=$(run_k3s pr-runtime "$WORK/data/version" "$WORK/no-kubeconfig" --version 2>/dev/null) || fail
[[ $VERSION_OUTPUT == *"$EXPECTED_K3S_VERSION"* ]] || fail

STAGE=source-server-start
start_k3s pr-runtime "$SOURCE_DATA" "$SOURCE_CONFIG" "$SOURCE_LOG" server \
  --data-dir "$SOURCE_DATA" --cluster-init \
  --node-name runtime-rehearsal --node-ip 10.253.40.2 --advertise-address 10.253.40.2 \
  --tls-san 10.253.40.1 \
  --write-kubeconfig "$SOURCE_CONFIG" --write-kubeconfig-mode 0600 \
  --disable coredns --disable servicelb --disable traefik --disable local-storage --disable metrics-server
SOURCE_SERVER_PID=$STARTED_PID

STAGE=source-api-ready
wait_for_api pr-runtime "$SOURCE_DATA" "$SOURCE_CONFIG" 10.253.40.2 || fail
run_kubectl pr-runtime "$SOURCE_DATA" "$SOURCE_CONFIG" 10.253.40.2 \
  wait --for=condition=Ready node/runtime-rehearsal --timeout=180s >/dev/null 2>&1 || fail
STAGE=source-containerd-ready
SOURCE_CONTAINERD_SOCKET=$SOURCE_DATA/agent/containerd/containerd.sock
wait_for_socket "$SOURCE_CONTAINERD_SOCKET" || fail
run_k3s pr-runtime "$SOURCE_DATA" "$SOURCE_CONFIG" ctr \
  --address "$SOURCE_CONTAINERD_SOCKET" --namespace k8s.io images import /mnt/pause.oci.tar \
  >"$WORK/logs/image-import.log" 2>&1 || fail

STAGE=source-pod-create
cat > "$POD_MANIFEST" <<'POD'
apiVersion: v1
kind: Pod
metadata:
  name: transition-probe
  namespace: default
  labels:
    app.kubernetes.io/name: transition-probe
spec:
  nodeName: runtime-rehearsal
  hostNetwork: true
  restartPolicy: Always
  tolerations:
    - operator: Exists
  containers:
    - name: hold
      image: docker.io/rancher/mirrored-pause:3.10.2
      imagePullPolicy: Never
      volumeMounts:
        - name: workspace-probe
          mountPath: /data
  volumes:
    - name: workspace-probe
      emptyDir: {}
POD
run_kubectl pr-runtime "$SOURCE_DATA" "$SOURCE_CONFIG" 10.253.40.2 \
  apply -f "$POD_MANIFEST" >/dev/null 2>&1 || fail
run_kubectl pr-runtime "$SOURCE_DATA" "$SOURCE_CONFIG" 10.253.40.2 \
  wait --for=condition=Ready pod/transition-probe -n default --timeout=180s >/dev/null 2>&1 || fail

SOURCE_IDENTITY=$(container_identity pr-runtime "$SOURCE_DATA" "$SOURCE_CONFIG" 10.253.40.2) || fail
IFS=$'\t' read -r SOURCE_POD_UID SOURCE_CONTAINER_ID SOURCE_STARTED_AT <<<"$SOURCE_IDENTITY"
[[ $SOURCE_POD_UID =~ ^[0-9a-f-]{36}$ ]] || fail
[[ $SOURCE_CONTAINER_ID =~ ^containerd://[0-9a-f]{64}$ ]] || fail
SOURCE_CONTAINER_SHORT=${SOURCE_CONTAINER_ID#containerd://}
SOURCE_TASK_PID=$(task_pid pr-runtime "$SOURCE_DATA" "$SOURCE_CONTAINER_SHORT") || fail
[[ $SOURCE_TASK_PID =~ ^[1-9][0-9]*$ ]] || fail

STAGE=source-emptydir-marker
SOURCE_MARKER_PATH="/proc/$SOURCE_TASK_PID/root/data/$EMPTYDIR_MARKER_NAME"
[[ -d "/proc/$SOURCE_TASK_PID/root/data" ]] || fail
printf '%s' "$EMPTYDIR_MARKER_CONTENT" > "$SOURCE_MARKER_PATH"
emptydir_marker_matches "$SOURCE_TASK_PID" || fail

STAGE=synthetic-snapshot
run_k3s pr-runtime "$SOURCE_DATA" "$SOURCE_CONFIG" etcd-snapshot save \
  --name praetorium-transition-rehearsal >"$WORK/logs/snapshot.log" 2>&1 || fail
SNAPSHOT=$(find "$SOURCE_DATA/server/db/snapshots" -maxdepth 1 -type f \
  -name 'praetorium-transition-rehearsal*' -print -quit)
[[ -n $SNAPSHOT && -f $SNAPSHOT ]] || fail
[[ -f $SOURCE_DATA/server/token ]] || fail

STAGE=source-server-stop
kill -TERM "$SOURCE_SERVER_PID" || fail
SOURCE_EXITED=false
for _ in $(seq 1 30); do
  if ! kill -0 "$SOURCE_SERVER_PID" 2>/dev/null; then
    SOURCE_EXITED=true
    break
  fi
  sleep 1
done
[[ $SOURCE_EXITED == true ]] || fail
wait "$SOURCE_SERVER_PID" 2>/dev/null || true
SOURCE_SERVER_PID=

if kill -0 "$SOURCE_TASK_PID" 2>/dev/null; then
  TASK_SURVIVED_SERVER_STOP=true
else
  TASK_SURVIVED_SERVER_STOP=false
fi
SOURCE_EMPTYDIR_MARKER_AFTER_STOP=false
if emptydir_marker_matches "$SOURCE_TASK_PID"; then
  SOURCE_EMPTYDIR_MARKER_AFTER_STOP=true
fi

STAGE=private-server-credentials
[[ -d $SOURCE_DATA/server/cred && -d $SOURCE_DATA/server/tls && -f $SOURCE_DATA/server/token ]] || fail
mkdir -p "$MGMT_DATA/server"
cp -a "$SOURCE_DATA/server/cred" "$MGMT_DATA/server/"
cp -a "$SOURCE_DATA/server/tls" "$MGMT_DATA/server/"
cp -a "$SOURCE_DATA/server/token" "$MGMT_DATA/server/token"
SOURCE_CA_SHA256=$(sha256_file "$SOURCE_DATA/server/tls/server-ca.crt")
[[ -n $SOURCE_CA_SHA256 ]] || fail

STAGE=management-datastore-restore
run_k3s pr-mgmt "$MGMT_DATA" "$MGMT_CONFIG" server \
  --data-dir "$MGMT_DATA" --cluster-reset --cluster-reset-restore-path "$SNAPSHOT" \
  --token-file "$SOURCE_DATA/server/token" --disable-agent \
  --node-name management-rehearsal --node-ip 10.253.40.1 --advertise-address 10.253.40.1 \
  --tls-san 10.253.40.1 \
  --write-kubeconfig "$MGMT_CONFIG" --write-kubeconfig-mode 0600 \
  --disable coredns --disable servicelb --disable traefik --disable local-storage --disable metrics-server \
  >"$MGMT_RESTORE_LOG" 2>&1 || fail

STAGE=management-server-start
start_k3s pr-mgmt "$MGMT_DATA" "$MGMT_CONFIG" "$MGMT_LOG" server \
  --data-dir "$MGMT_DATA" --token-file "$SOURCE_DATA/server/token" --disable-agent \
  --node-name management-rehearsal --node-ip 10.253.40.1 --advertise-address 10.253.40.1 \
  --tls-san 10.253.40.1 \
  --write-kubeconfig "$MGMT_CONFIG" --write-kubeconfig-mode 0600 \
  --disable coredns --disable servicelb --disable traefik --disable local-storage --disable metrics-server
MGMT_SERVER_PID=$STARTED_PID
wait_for_api pr-mgmt "$MGMT_DATA" "$MGMT_CONFIG" 10.253.40.1 || fail
MGMT_CA_SHA256=$(sha256_file "$MGMT_DATA/server/tls/server-ca.crt")
[[ $MGMT_CA_SHA256 == "$SOURCE_CA_SHA256" ]] || fail
MGMT_SOURCE_IDENTITY=$(container_identity pr-mgmt "$MGMT_DATA" "$MGMT_CONFIG" 10.253.40.1) || fail
IFS=$'\t' read -r RESTORED_POD_UID RESTORED_CONTAINER_ID RESTORED_STARTED_AT <<<"$MGMT_SOURCE_IDENTITY"
[[ $RESTORED_POD_UID == "$SOURCE_POD_UID" && $RESTORED_CONTAINER_ID == "$SOURCE_CONTAINER_ID" && $RESTORED_STARTED_AT == "$SOURCE_STARTED_AT" ]] || fail
BASELINE_LEASE=$(lease_renew_time pr-mgmt "$MGMT_DATA" "$MGMT_CONFIG" 10.253.40.1) || fail
[[ -n $BASELINE_LEASE ]] || fail

STAGE=runtime-agent-start
start_k3s pr-runtime "$SOURCE_DATA" "$SOURCE_CONFIG" "$AGENT_LOG" agent \
  --data-dir "$SOURCE_DATA" --server https://10.253.40.1:6443 \
  --token-file "$SOURCE_DATA/server/token" \
  --node-name runtime-rehearsal --node-ip 10.253.40.2
RUNTIME_AGENT_PID=$STARTED_PID

STAGE=agent-node-ready
LEASE_CHANGED=false
for _ in $(seq 1 120); do
  CURRENT_LEASE=$(lease_renew_time pr-mgmt "$MGMT_DATA" "$MGMT_CONFIG" 10.253.40.1 2>/dev/null || true)
  if [[ -n $CURRENT_LEASE && $CURRENT_LEASE != "$BASELINE_LEASE" ]]; then
    LEASE_CHANGED=true
    break
  fi
  sleep 2
done
[[ $LEASE_CHANGED == true ]] || fail
run_kubectl pr-mgmt "$MGMT_DATA" "$MGMT_CONFIG" 10.253.40.1 \
  wait --for=condition=Ready node/runtime-rehearsal --timeout=60s >/dev/null 2>&1 || fail
run_kubectl pr-mgmt "$MGMT_DATA" "$MGMT_CONFIG" 10.253.40.1 \
  wait --for=condition=Ready pod/transition-probe -n default --timeout=240s >/dev/null 2>&1 || fail

POST_IDENTITY=$(container_identity pr-mgmt "$MGMT_DATA" "$MGMT_CONFIG" 10.253.40.1) || fail
IFS=$'\t' read -r POST_POD_UID POST_CONTAINER_ID POST_STARTED_AT <<<"$POST_IDENTITY"
[[ $POST_POD_UID =~ ^[0-9a-f-]{36}$ && $POST_CONTAINER_ID =~ ^containerd://[0-9a-f]{64}$ ]] || fail
POST_CONTAINER_SHORT=${POST_CONTAINER_ID#containerd://}
POST_TASK_PID=$(task_pid pr-runtime "$SOURCE_DATA" "$POST_CONTAINER_SHORT") || fail
[[ $POST_TASK_PID =~ ^[1-9][0-9]*$ ]] || fail

POD_UID_CONTINUOUS=false
CONTAINER_ID_CONTINUOUS=false
TASK_PID_CONTINUOUS=false
EMPTYDIR_MARKER_CONTINUOUS=false
[[ $POST_POD_UID == "$SOURCE_POD_UID" ]] && POD_UID_CONTINUOUS=true
[[ $POST_CONTAINER_ID == "$SOURCE_CONTAINER_ID" ]] && CONTAINER_ID_CONTINUOUS=true
[[ $POST_TASK_PID == "$SOURCE_TASK_PID" ]] && TASK_PID_CONTINUOUS=true
if emptydir_marker_matches "$POST_TASK_PID"; then
  EMPTYDIR_MARKER_CONTINUOUS=true
fi

STAGE=complete
printf 'PASS: isolated same-version Server-to-Agent rehearsal completed\n'
printf 'sourceServerExited=true; sourceTaskSurvivedServerStop=%s; nodeReady=true\n' "$TASK_SURVIVED_SERVER_STOP"
printf 'podUidContinuous=%s; containerIdContinuous=%s; taskPidContinuous=%s; emptyDirMarkerContinuous=%s\n' \
  "$POD_UID_CONTINUOUS" "$CONTAINER_ID_CONTINUOUS" "$TASK_PID_CONTINUOUS" "$EMPTYDIR_MARKER_CONTINUOUS"
printf 'emptyDirMarkerAfterServerStop=%s\n' "$SOURCE_EMPTYDIR_MARKER_AFTER_STOP"
printf 'restoredServerCaMatched=true; nodeLeaseRenewed=true\n'
printf 'sourceStartedAtPreserved=%s\n' "$([[ $POST_STARTED_AT == "$SOURCE_STARTED_AT" ]] && printf true || printf false)"
printf 'sourceClusterWasSynthetic=true; hostRootWritable=false; productionDataMounted=false; networkEgress=false\n'

# Exiting the private PID namespace terminates any remaining K3s/containerd/shim
# processes. The private mount namespace then drops all temporary K3s state.
exit 0
