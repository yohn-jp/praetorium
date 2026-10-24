#!/usr/bin/env bash
set -euo pipefail
umask 077

# Root-applied, bounded substrate for the T14 disposable Kind/BuildKit host.
# This does not alter the production BuildKit service or open host firewall ports.
readonly OWNER='praetorium-t14'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly STATE_MODULE="$SCRIPT_DIR/remote-disposable-builder-state.mjs"
readonly BASE='/var/lib/praetorium-t14'
readonly IMAGE="$BASE/state.img"
readonly MOUNT="$BASE/state"
readonly MARKER="$BASE/owner.json"
readonly CGROUP_RECEIPT="$BASE/cgroup-verification.json"
readonly JOURNAL='/var/lib/.praetorium-t14-setup.json'
readonly CLUSTER='praetorium-t14-canary'
readonly CONTEXT='kind-praetorium-t14-canary'
readonly MOUNT_UNIT='var-lib-praetorium\x2dt14-state.mount'
readonly SLICE_UNIT='praetorium-t14.slice'
readonly TEST_BUILDKIT_UNIT='praetorium-buildkit-t14.service'
readonly RUN_UNIT_PREFIX='praetorium-t14-acceptance'
readonly IMAGE_BYTES=6442450944
readonly SUBID_START=3000000
readonly SUBID_COUNT=65536
readonly EXPECTED_NODE_IMAGE='kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f'
readonly TEST_PATH='/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
readonly ENV_BIN='/usr/bin/env'

usage() { echo "usage: $0 plan|setup|run|verify-cgroup|cleanup [command ...]" >&2; exit 2; }
[[ $# -ge 1 ]] || usage
action=$1
shift
[[ $action == plan || $action == setup || $action == run || $action == verify-cgroup || $action == cleanup ]] || usage
if [[ $action != run && $# != 0 ]]; then usage; fi

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"; }
subid_status() { node "$STATE_MODULE" subid-status "$1" "$OWNER" "$SUBID_START" "$SUBID_COUNT"; }

verify_runtime_helper() {
  [[ -f $STATE_MODULE && ! -L $STATE_MODULE && -r $STATE_MODULE ]] || fail 'T14 state helper must be a readable regular file'
  state_module_mode=$(stat -c '%a' "$STATE_MODULE")
  [[ $(stat -c '%u' "$STATE_MODULE") == 0 ]] && (( (8#$state_module_mode & 0022) == 0 && (8#$state_module_mode & 0004) != 0 )) || fail 'T14 state helper must be root-owned, readable, and not group/world writable'
  state_module_real=$(realpath "$STATE_MODULE")
  case "$state_module_real" in
    /tmp/*|/var/tmp/*) fail 'T14 state helper cannot reside on a temporary filesystem hidden by the acceptance service' ;;
  esac
  helper_directory=$(dirname "$state_module_real")
  while [[ $helper_directory != / ]]; do
    helper_directory_mode=$(stat -c '%a' "$helper_directory")
    (( (8#$helper_directory_mode & 0001) != 0 )) || fail "T14 state helper parent is not traversable by its service account: $helper_directory"
    helper_directory=${helper_directory%/*}
    [[ -n $helper_directory ]] || helper_directory=/
  done
}

check_subid_free() {
  local file=$1 start=$SUBID_START end=$((SUBID_START + SUBID_COUNT - 1))
  [[ -f $file ]] || return 0
  awk -F: -v s="$start" -v e="$end" '$2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { a=$2; b=$2+$3-1; if (s<=b && a<=e) exit 1 }' "$file" \
    || fail "subordinate ID range $start-$end overlaps an existing range in $file"
}

check_tools() {
  local required_root_free=${1:-10737418240}
  need systemctl; need systemd-run; need systemd-analyze; need podman; need fuse-overlayfs; need kind; need kubectl; need node; need pnpm; need ss; need newuidmap; need newgidmap; need losetup; need realpath; need useradd; need usermod; need getent; need runuser; need bash; need fallocate; need mkfs.ext4; need blkid; need python3; need "$ENV_BIN"
  [[ $(podman --version) == 'podman version 5.7.0' ]] || fail 'Podman must be the observed apt version 5.7.0'
  [[ $(kind --version) == 'kind v0.31.0 '* ]] || fail 'Kind must be pinned to v0.31.0'
  [[ $(node --version) == v24.* ]] || fail 'Node must be v24'
  [[ $(pnpm --version) == 11.18.0 ]] || fail 'pnpm must be 11.18.0'
  kubectl_version=$(kubectl version --client --output=json | node "$STATE_MODULE" kubectl-version) || fail 'kubectl client version JSON is invalid'
  [[ $kubectl_version == v1.35.0 ]] || fail "kubectl must be pinned to v1.35.0 (found $kubectl_version)"
  [[ $(systemctl is-active praetorium-buildkit.service) == active ]] || fail 'protected production BuildKit must remain active'
  systemctl show praetorium-buildkit.service -p ExecStart --value | grep -q '10\.7\.0\.32:1234' || fail 'protected BuildKit target is not the expected :1234 listener'
  if ss -ltnH | awk '{print $4}' | grep -Eq ':1235$'; then fail 'test Builder port 1235 is already bound'; fi
  [[ $(cat /sys/fs/cgroup/cgroup.controllers) == *cpu* ]] || fail 'cgroup v2 cpu controller unavailable'
  [[ $(cat /sys/fs/cgroup/cgroup.controllers) == *memory* ]] || fail 'cgroup v2 memory controller unavailable'
  [[ $(cat /sys/fs/cgroup/cgroup.controllers) == *pids* ]] || fail 'cgroup v2 pids controller unavailable'
  [[ -c /dev/fuse ]] || fail '/dev/fuse unavailable'
  [[ -r /proc/filesystems ]] && grep -Eq '^nodev[[:space:]]+overlay$' /proc/filesystems || fail 'overlay filesystem unavailable'
  for helper in "$(command -v newuidmap)" "$(command -v newgidmap)"; do
    [[ -x $helper && $(stat -c '%u:%a' "$helper") == '0:4755' ]] || fail "root-owned setuid namespace helper unavailable: $helper"
  done
  [[ $(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 0) == 1 ]] || fail 'unprivileged user namespaces unavailable'
  [[ $(awk '/MemAvailable:/ {print $2}' /proc/meminfo) -ge 8388608 ]] || fail 'less than 8 GiB MemAvailable'
  [[ $(df -B1 --output=avail / | tail -1 | tr -d ' ') -ge $required_root_free ]] || fail "less than required free root space ($required_root_free bytes)"
}

recovery_root_headroom() {
  local allocated=0 remaining
  if [[ -e $IMAGE || -L $IMAGE ]]; then
    [[ -f $IMAGE && ! -L $IMAGE && $(stat -c '%u' "$IMAGE") == 0 ]] || fail 'journaled state image path is not a root-owned regular file'
    allocated=$(du -B1 "$IMAGE" | awk '{print $1}')
  fi
  remaining=$((IMAGE_BYTES - allocated))
  (( remaining < 0 )) && remaining=0
  printf '%s' "$((4294967296 + remaining))"
}

write_marker() {
  local uuid=$1 owner_uid=$2 owner_gid=$3 mount_hash slice_hash
  mount_hash=$(sha256sum "/etc/systemd/system/$MOUNT_UNIT" | awk '{print $1}')
  slice_hash=$(sha256sum "/etc/systemd/system/$SLICE_UNIT" | awk '{print $1}')
  if [[ ! -e $MARKER ]]; then
    node "$STATE_MODULE" write \
      "$MARKER" "$uuid" "$mount_hash" "$slice_hash" "$owner_uid" "$owner_gid"
  else
    node "$STATE_MODULE" validate "$MARKER"
  fi
  node "$STATE_MODULE" validate "$MARKER"
  [[ $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["filesystemUuid"])' "$MARKER") == "$uuid" ]] || fail 'owner marker UUID differs from the mounted image'
  [[ $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["mountUnitSha256"])' "$MARKER") == "$mount_hash" ]] || fail 'owner marker mount unit hash differs'
  [[ $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sliceUnitSha256"])' "$MARKER") == "$slice_hash" ]] || fail 'owner marker slice unit hash differs'
  install -d -o root -g root -m 0700 "$MOUNT/.praetorium-t14"
  if [[ ! -e "$MOUNT/.praetorium-t14/owner.json" ]]; then
    install -m 0600 -o root -g root "$MARKER" "$MOUNT/.praetorium-t14/owner.json"
  else
    cmp -s "$MARKER" "$MOUNT/.praetorium-t14/owner.json" || fail 'existing in-volume owner marker differs'
  fi
}

verify_marker() {
  [[ -f $MARKER && ! -L $MARKER ]] || fail 'owner marker missing or symlinked'
  [[ $(stat -c '%u:%a' "$MARKER") == '0:600' ]] || fail 'owner marker must be root-owned mode 0600'
  node "$STATE_MODULE" validate "$MARKER"
  marker_uid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ownerUid"])' "$MARKER")
  marker_gid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ownerGid"])' "$MARKER")
  [[ $(id -u "$OWNER") == "$marker_uid" && $(id -g "$OWNER") == "$marker_gid" ]] || fail 'T14 account UID/GID differs from owner marker'
  python3 - "$MARKER" <<'PY'
import hashlib,json,os,stat,sys
p=json.load(open(sys.argv[1]))
for key,path in [('mountUnitSha256','/etc/systemd/system/'+p['mountUnit']),('sliceUnitSha256','/etc/systemd/system/'+p['sliceUnit'])]:
    st=os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode & 0o022:
        raise SystemExit('owned systemd unit is unsafe: '+path)
    if hashlib.sha256(open(path,'rb').read()).hexdigest()!=p.get(key):
        raise SystemExit('owned systemd unit differs from marker: '+path)
PY
  [[ $(findmnt -rn -o TARGET --target "$MOUNT") == "$MOUNT" ]] || fail 'owned state volume is not mounted at the exact target'
  local uuid image
  uuid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["filesystemUuid"])' "$MARKER")
  image=$(findmnt -rn -o SOURCE --target "$MOUNT")
  [[ $(blkid -s UUID -o value "$image") == "$uuid" ]] || fail 'mounted filesystem UUID does not match the owner marker'
  [[ $(realpath "$(losetup -n -O BACK-FILE "$image")") == "$(realpath "$IMAGE")" ]] || fail 'mounted loop device is not backed by the marker-owned image'
  local nested_mounts
  nested_mounts=$(findmnt -rn -o TARGET | awk -v p="$MOUNT" '$0 == p || index($0,p"/")==1')
  [[ $nested_mounts == "$MOUNT" ]] || fail 'unexpected nested mount exists below the owned state volume'
}

if [[ $action == plan ]]; then
  (( EUID == 0 )) || fail 'run plan through the Builder host with sudo for an authoritative preflight'
  verify_runtime_helper
  if [[ -e $JOURNAL || -L $JOURNAL ]]; then
    node "$STATE_MODULE" journal-validate "$JOURNAL"
    check_tools "$(recovery_root_headroom)"
    printf 'RECOVERY_REQUIRED: exact staged journal exists; rerun setup to continue forward recovery\n'
    exit 0
  fi
  check_tools
  [[ ! -e $BASE && ! -L $BASE && ! -e $IMAGE && ! -L $IMAGE && ! -e $MOUNT && ! -L $MOUNT ]] || fail 'T14 state already exists; inspect ownership before proceeding'
  [[ ! -e "/etc/systemd/system/$MOUNT_UNIT" && ! -L "/etc/systemd/system/$MOUNT_UNIT" ]] || fail 'T14 mount unit path is occupied'
  [[ ! -e "/etc/systemd/system/$SLICE_UNIT" && ! -L "/etc/systemd/system/$SLICE_UNIT" ]] || fail 'T14 slice unit path is occupied'
  [[ $(systemctl show "$TEST_BUILDKIT_UNIT" -p LoadState --value 2>/dev/null || true) == not-found ]] || fail 'T14 BuildKit unit name is already occupied'
  ! getent passwd "$OWNER" >/dev/null || fail "account $OWNER exists without an owner journal"
  ! getent group "$OWNER" >/dev/null || fail "group $OWNER exists without an owner journal"
  [[ $(subid_status /etc/subuid) == missing && $(subid_status /etc/subgid) == missing ]] || fail 'orphaned subordinate ID mapping exists for the T14 account name'
  check_subid_free /etc/subuid; check_subid_free /etc/subgid
  printf 'READY: rootless test account=%s subids=%s:%s state=%s bytes=%s cgroup=2CPU/4GiB/2048tasks testport=10.7.0.32:1235 protected=10.7.0.32:1234 cluster=%s node=%s\n' \
    "$OWNER" "$SUBID_START" "$SUBID_COUNT" "$IMAGE" "$IMAGE_BYTES" "$CLUSTER" "$EXPECTED_NODE_IMAGE"
  exit 0
fi

(( EUID == 0 )) || fail "$action requires root"

if [[ $action == setup ]]; then
  verify_runtime_helper
  if [[ -e $JOURNAL || -L $JOURNAL ]]; then
    node "$STATE_MODULE" journal-validate "$JOURNAL"
    check_tools "$(recovery_root_headroom)"
  else
    check_tools
    [[ ! -e $BASE && ! -L $BASE && ! -e $IMAGE && ! -L $IMAGE && ! -e $MOUNT && ! -L $MOUNT ]] || fail 'T14 paths already exist without a setup journal; refusing to adopt'
    [[ ! -e "/etc/systemd/system/$MOUNT_UNIT" && ! -L "/etc/systemd/system/$MOUNT_UNIT" ]] || fail 'T14 mount unit path is occupied'
    [[ ! -e "/etc/systemd/system/$SLICE_UNIT" && ! -L "/etc/systemd/system/$SLICE_UNIT" ]] || fail 'T14 slice unit path is occupied'
    [[ $(systemctl show "$TEST_BUILDKIT_UNIT" -p LoadState --value 2>/dev/null || true) == not-found ]] || fail 'T14 BuildKit unit name is already occupied; refusing to adopt it'
    ! getent passwd "$OWNER" >/dev/null || fail "account $OWNER exists without a setup journal"
    ! getent group "$OWNER" >/dev/null || fail "group $OWNER exists without a setup journal"
    [[ $(subid_status /etc/subuid) == missing && $(subid_status /etc/subgid) == missing ]] || fail 'orphaned subordinate ID mapping exists for the T14 account name'
    check_subid_free /etc/subuid; check_subid_free /etc/subgid
    node "$STATE_MODULE" journal-init "$JOURNAL"
  fi
  if [[ ! -e $BASE ]]; then install -d -o root -g root -m 0711 "$BASE"; fi
  [[ -d $BASE && ! -L $BASE && $(stat -c '%u:%a' "$BASE") == '0:711' ]] || fail 'T14 base directory must be root-owned mode 0711'
  if [[ ! -e $MOUNT ]]; then install -d -o root -g root -m 0700 "$MOUNT"; fi
  if [[ $(findmnt -rn -o TARGET --target "$MOUNT" 2>/dev/null || true) != "$MOUNT" ]]; then
    [[ -d $MOUNT && ! -L $MOUNT && $(stat -c '%u:%a' "$MOUNT") == '0:700' ]] || fail 'T14 mountpoint must be root-owned mode 0700 before mounting'
  fi
  if ! getent passwd "$OWNER" >/dev/null; then
    useradd --system --user-group --home-dir "$MOUNT/home" --shell /bin/bash "$OWNER"
  fi
  account=$(getent passwd "$OWNER") || fail 'disposable account readback failed'
  account_home=$(cut -d: -f6 <<<"$account")
  account_shell=$(cut -d: -f7 <<<"$account")
  account_uid=$(id -u "$OWNER")
  account_gid=$(id -g "$OWNER")
  [[ $account_home == "$MOUNT/home" && $account_shell == /bin/bash && $(getent group "$OWNER" | cut -d: -f3) == "$account_gid" ]] || fail 'disposable account/group identity differs from T14 contract'
  for file in /etc/subuid /etc/subgid; do
    status=$(subid_status "$file")
    if [[ $status == missing ]]; then
      check_subid_free "$file"
      if [[ $file == /etc/subuid ]]; then usermod --add-subuids "$SUBID_START-$((SUBID_START + SUBID_COUNT - 1))" "$OWNER"; else usermod --add-subgids "$SUBID_START-$((SUBID_START + SUBID_COUNT - 1))" "$OWNER"; fi
    fi
  done
  [[ $(subid_status /etc/subuid) == exact && $(subid_status /etc/subgid) == exact ]] || fail 'subordinate ID readback does not match exact allocation'
  node "$STATE_MODULE" journal-stage "$JOURNAL" account "$account_uid" "$account_gid"
  if [[ ! -e $IMAGE ]]; then fallocate -l "$IMAGE_BYTES" "$IMAGE"; fi
  [[ -f $IMAGE && ! -L $IMAGE && $(stat -c '%u' "$IMAGE") == 0 ]] || fail 'T14 state image is not a root-owned regular file'
  [[ $(stat -c '%s' "$IMAGE") == "$IMAGE_BYTES" ]] || fallocate -l "$IMAGE_BYTES" "$IMAGE"
  chmod 0600 "$IMAGE"
  [[ $(stat -c '%u:%a:%s' "$IMAGE") == "0:600:$IMAGE_BYTES" ]] || fail 'T14 state image is not a root-owned 6 GiB private file'
  image_type=$(blkid -s TYPE -o value "$IMAGE" 2>/dev/null || true)
  if [[ -z $image_type ]]; then mkfs.ext4 -F -q "$IMAGE"; elif [[ $image_type != ext4 ]]; then fail 'journal-owned image has unexpected filesystem type'; fi
  local_uuid=$(blkid -s UUID -o value "$IMAGE")
  node "$STATE_MODULE" journal-stage "$JOURNAL" image "$account_uid" "$account_gid" "$local_uuid"
  mount_unit_tmp=$(mktemp)
  node "$STATE_MODULE" render-mount > "$mount_unit_tmp"
  slice_unit_tmp=$(mktemp)
  node "$STATE_MODULE" render-slice > "$slice_unit_tmp"
  for entry in "$MOUNT_UNIT:$mount_unit_tmp" "$SLICE_UNIT:$slice_unit_tmp"; do
    unit=${entry%%:*}; source=${entry#*:}; destination="/etc/systemd/system/$unit"
    chmod 0644 "$source"
    if [[ -e $destination || -L $destination ]]; then
      [[ -f $destination && ! -L $destination ]] && cmp -s "$source" "$destination" || fail "existing unit differs from T14 contract: $unit"
    else
      install -o root -g root -m 0644 "$source" "$destination"
    fi
  done
  rm -f "$mount_unit_tmp" "$slice_unit_tmp"
  systemd-analyze verify "/etc/systemd/system/$MOUNT_UNIT" "/etc/systemd/system/$SLICE_UNIT"
  node "$STATE_MODULE" journal-stage "$JOURNAL" units "$account_uid" "$account_gid" "$local_uuid"
  systemctl daemon-reload
  systemctl enable --now "$MOUNT_UNIT"
  node "$STATE_MODULE" journal-stage "$JOURNAL" mounted "$account_uid" "$account_gid" "$local_uuid"
  write_marker "$local_uuid" "$account_uid" "$account_gid"
  chown "$OWNER:$OWNER" "$MOUNT"
  install -d -o "$OWNER" -g "$OWNER" -m 0700 "$MOUNT/home" "$MOUNT/home/tmp" "$MOUNT/podman" "$MOUNT/kube" "$MOUNT/logs" "$MOUNT/credentials"
  install -d -o "$OWNER" -g "$OWNER" -m 0700 "$MOUNT/home/.config/containers"
  cat > "$MOUNT/home/.config/containers/storage.conf" <<EOF
[storage]
driver = "overlay"
graphroot = "$MOUNT/podman/graphroot"
runroot = "/run/user/$(id -u "$OWNER")/containers"
EOF
  cat > "$MOUNT/home/.config/containers/containers.conf" <<'EOF'
[engine]
cgroup_manager = "cgroupfs"
EOF
  chmod 0600 "$MOUNT/home/.config/containers/storage.conf"
  chmod 0600 "$MOUNT/home/.config/containers/containers.conf"
  chown "$OWNER:$OWNER" "$MOUNT/home/.config/containers/storage.conf" "$MOUNT/home/.config/containers/containers.conf"
  install -d -o "$OWNER" -g "$OWNER" -m 0700 "/run/user/$(id -u "$OWNER")" "/run/user/$(id -u "$OWNER")/containers"
  verify_marker
  node "$STATE_MODULE" journal-stage "$JOURNAL" ready "$account_uid" "$account_gid" "$local_uuid"
  node "$STATE_MODULE" journal-remove "$JOURNAL"
  echo "READY: T14 host substrate created. No Kind cluster or workload started. Use the bounded transient acceptance service inside $SLICE_UNIT."
  exit 0
fi

if [[ $action == run ]]; then
  (( EUID == 0 )) || fail 'run must be invoked through sudo so systemd can place the process in the bounded system slice'
  [[ $# -gt 0 ]] || usage
  verify_runtime_helper
  verify_marker
  test_uid=$(id -u "$OWNER")
  slice_hash=$(sha256sum "/etc/systemd/system/$SLICE_UNIT" | awk '{print $1}')
  node "$STATE_MODULE" cgroup-validate "$CGROUP_RECEIPT" "$test_uid" "$slice_hash"
  live_slice_path="/sys/fs/cgroup$(systemctl show "$SLICE_UNIT" -p ControlGroup --value)"
  [[ $(cat "$live_slice_path/cpu.max") == '200000 100000' && $(cat "$live_slice_path/memory.max") == '4294967296' && $(cat "$live_slice_path/pids.max") == '2048' ]] || fail 'live T14 slice limits changed after cgroup verification'
  install -d -o "$OWNER" -g "$OWNER" -m 0700 "/run/user/$test_uid" "/run/user/$test_uid/containers"
  node_bin=$(realpath "$(command -v node)")
  unit="$RUN_UNIT_PREFIX-$(date +%s)-$$.service"
  exec systemd-run --wait --pipe --collect --slice="$SLICE_UNIT" --unit="$unit" \
    --uid="$OWNER" --property=Type=exec --property=Delegate=yes \
    --property=SetLoginEnvironment=yes --property=ProtectSystem=strict \
    --property="TemporaryFileSystem=/tmp:size=512M" \
    --property="TemporaryFileSystem=/var/tmp:size=128M" \
    --property="ReadWritePaths=$MOUNT /run/user/$test_uid" \
    --property="WorkingDirectory=$MOUNT/home" \
    --property="UnsetEnvironment=GITHUB_TOKEN GH_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY HTTP_PROXY HTTPS_PROXY ALL_PROXY" \
    --property="Environment=PATH=$TEST_PATH" \
    --property="Environment=XDG_CONFIG_HOME=$MOUNT/home/.config" \
    --property="Environment=XDG_DATA_HOME=$MOUNT/home/.local/share" \
    --property="Environment=XDG_RUNTIME_DIR=/run/user/$test_uid" \
    --property="Environment=KUBECONFIG=$MOUNT/kube/config" \
    --property="Environment=TMPDIR=/tmp" \
    --property="Environment=PRAETORIUM_TEST_TMPDIR=/tmp" \
    --property="Environment=CONTAINERS_STORAGE_CONF=$MOUNT/home/.config/containers/storage.conf" \
    --property="Environment=DOCKER_CONFIG=$MOUNT/home/.config/docker" \
    --property="Environment=REGISTRY_AUTH_FILE=$MOUNT/credentials/registry-auth.json" \
    --property="Environment=PRAETORIUM_T14_INVENTORY_PATH=$MOUNT/credentials/acceptance-inventory.json" \
    --property="Environment=PRAETORIUM_T14_GITHUB_ACCESS_CONFIG=$MOUNT/credentials/github-access.json" \
    --property="Environment=PRAETORIUM_SOURCE_FIXTURE_ARTIFACT_DIR=$MOUNT/logs/source-fixture" \
    --property=Environment=KIND_EXPERIMENTAL_PROVIDER=podman \
    -- "$node_bin" "$STATE_MODULE" exec -- /bin/bash -c 'cd -- "$1" || exit; shift; exec "$@"' praetorium-t14-run "$PWD" "$@"
fi

if [[ $action == verify-cgroup ]]; then
  (( EUID == 0 )) || fail 'verify-cgroup requires root'
  verify_marker
  probe="praetorium-t14-cgroup-probe-$$.service"
  test_uid=$(id -u "$OWNER")
  systemd-run --wait --pipe --collect --slice="$SLICE_UNIT" --unit="$probe" --uid="$OWNER" \
    --property=Type=exec --property=Delegate=yes --property=SetLoginEnvironment=yes \
    --property=ProtectSystem=strict --property="TemporaryFileSystem=/tmp:size=16M" \
    --property="TemporaryFileSystem=/var/tmp:size=8M" \
    --property="ReadWritePaths=$MOUNT /run/user/$test_uid" \
    --property="WorkingDirectory=$MOUNT/home" \
    --property="UnsetEnvironment=GITHUB_TOKEN GH_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY REGISTRY_AUTH_FILE HTTP_PROXY HTTPS_PROXY ALL_PROXY" \
    --property="Environment=PATH=$TEST_PATH" -- /usr/bin/sleep 5 &
  runner_pid=$!
  stop_probe() {
    systemctl stop "$probe" 2>/dev/null || true
    systemctl kill "$probe" 2>/dev/null || true
    kill "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  }
  trap stop_probe EXIT
  control_group=''
  for _ in {1..40}; do
    kill -0 "$runner_pid" 2>/dev/null || fail 'transient delegated service exited before cgroup readback'
    control_group=$(systemctl show "$probe" -p ControlGroup --value 2>/dev/null || true)
    [[ -n $control_group ]] && break
    sleep 0.1
  done
  [[ $control_group == *"$SLICE_UNIT/"* ]] || fail 'transient service is not beneath the T14 slice'
  [[ $(systemctl show "$probe" -p Slice --value) == "$SLICE_UNIT" ]] || fail 'transient service Slice property differs'
  service_path="/sys/fs/cgroup$control_group"
  [[ -r $service_path/cpu.max && -r $service_path/memory.max && -r $service_path/pids.max ]] || fail 'delegated service cgroup controller files are unavailable'
  cpu_limit=$(cat "$service_path/cpu.max")
  memory_limit=$(cat "$service_path/memory.max")
  process_limit=$(cat "$service_path/pids.max")
  [[ $cpu_limit == '200000 100000' && $memory_limit == '4294967296' && $process_limit == '2048' ]] || fail "effective T14 service limits differ (cpu=$cpu_limit memory=$memory_limit pids=$process_limit)"
  service_pids=$(cat "/sys/fs/cgroup$control_group/cgroup.procs")
  [[ -n $service_pids ]] || fail 'delegated service contains no live probe process'
  while IFS= read -r service_pid; do
    [[ $(awk '/^Uid:/ {print $2}' "/proc/$service_pid/status") == "$(id -u "$OWNER")" ]] || fail 'delegated probe process does not run as the T14 account'
  done <<<"$service_pids"
  test_uid=$(id -u "$OWNER")
  slice_hash=$(sha256sum "/etc/systemd/system/$SLICE_UNIT" | awk '{print $1}')
  node "$STATE_MODULE" cgroup-write "$CGROUP_RECEIPT" "$test_uid" "$slice_hash"
  echo "CGROUP_READY: service=$probe slice=$SLICE_UNIT cpu=$cpu_limit memory=$memory_limit pids=$process_limit"
  stop_probe
  trap - EXIT
  exit 0
fi

verify_marker
  if [[ -e $JOURNAL || -L $JOURNAL ]]; then
  node "$STATE_MODULE" journal-validate "$JOURNAL"
  node "$STATE_MODULE" journal-remove "$JOURNAL"
fi
getent passwd "$OWNER" >/dev/null || fail 'owned test account is missing; do not infer ownership'
need kind; need podman
test_uid=$(id -u "$OWNER")
account=$(getent passwd "$OWNER")
[[ $(cut -d: -f6 <<<"$account") == "$MOUNT/home" && $(cut -d: -f7 <<<"$account") == /bin/bash ]] || fail 'T14 account home/shell differs from owner contract'
account_gid=$(id -g "$OWNER")
group=$(getent group "$OWNER") || fail 'T14 primary group is missing'
[[ $(cut -d: -f3 <<<"$group") == "$account_gid" && -z $(cut -d: -f4 <<<"$group") ]] || fail 'T14 primary group ownership/membership differs from contract'
install -d -o "$OWNER" -g "$OWNER" -m 0700 "/run/user/$test_uid" "/run/user/$test_uid/containers"
[[ $(subid_status /etc/subuid) == exact && $(subid_status /etc/subgid) == exact ]] || fail 'disposable account subordinate ID records differ from the exact single allocated range'
if [[ $(systemctl show "$TEST_BUILDKIT_UNIT" -p LoadState --value 2>/dev/null || true) != not-found ]]; then fail 'T14 BuildKit unit exists; verify and remove it separately before substrate cleanup'; fi
if [[ -e $CGROUP_RECEIPT || -L $CGROUP_RECEIPT ]]; then
  [[ -f $CGROUP_RECEIPT && ! -L $CGROUP_RECEIPT && $(stat -c '%u:%a' "$CGROUP_RECEIPT") == '0:600' ]] || fail 'cgroup receipt path is not a private owner file'
  rm -f "$CGROUP_RECEIPT"
fi
clusters=$(runuser --user "$OWNER" -- "$ENV_BIN" -i "PATH=$TEST_PATH" \
    "XDG_CONFIG_HOME=$MOUNT/home/.config" \
    "XDG_DATA_HOME=$MOUNT/home/.local/share" \
    "XDG_RUNTIME_DIR=/run/user/$test_uid" \
    "TMPDIR=/tmp" \
    "KUBECONFIG=$MOUNT/kube/config" \
    "CONTAINERS_STORAGE_CONF=$MOUNT/home/.config/containers/storage.conf" \
    KIND_EXPERIMENTAL_PROVIDER=podman kind get clusters)
if grep -Fxq "$CLUSTER" <<<"$clusters"; then
  runuser --user "$OWNER" -- "$ENV_BIN" -i "PATH=$TEST_PATH" \
    "XDG_CONFIG_HOME=$MOUNT/home/.config" \
    "XDG_DATA_HOME=$MOUNT/home/.local/share" \
    "XDG_RUNTIME_DIR=/run/user/$test_uid" \
    "TMPDIR=/tmp" \
    "KUBECONFIG=$MOUNT/kube/config" \
    "CONTAINERS_STORAGE_CONF=$MOUNT/home/.config/containers/storage.conf" \
    KIND_EXPERIMENTAL_PROVIDER=podman kind delete cluster --name "$CLUSTER"
fi
test_uid=$(id -u "$OWNER")
kubeconfig="/tmp/praetorium-t12-$test_uid/$CLUSTER.yaml"
if [[ -e $kubeconfig || -L $kubeconfig ]]; then
  [[ -f $kubeconfig && ! -L $kubeconfig && $(stat -c '%u:%a' "$kubeconfig") == "$test_uid:600" ]] || fail 'canonical T14 kubeconfig is not a private regular file owned by the disposable account'
  rm -f "$kubeconfig"
fi
[[ -f "$MOUNT/.praetorium-t14/owner.json" ]] || fail 'in-volume owner marker missing; refusing cleanup'
cmp -s "$MARKER" "$MOUNT/.praetorium-t14/owner.json" || fail 'owner markers differ; refusing cleanup'
if pgrep -u "$OWNER" >/dev/null 2>&1; then fail 'disposable account still has processes; preserve the bounded volume'; fi
# Delete only contents of the exact, marker-verified, single filesystem. This is
# deliberately done before unmount so the image can be removed without touching
# any adjacent Builder state.
find "$MOUNT" -xdev -mindepth 1 -depth \
  ! -path "$MOUNT/.praetorium-t14" \
  ! -path "$MOUNT/.praetorium-t14/owner.json" -delete
systemctl disable --now "$MOUNT_UNIT"
[[ $(findmnt -rn -o TARGET --target "$MOUNT" 2>/dev/null || true) != "$MOUNT" ]] || fail 'owned state is still mounted after unit stop'
rm -f "/etc/systemd/system/$SLICE_UNIT" "/etc/systemd/system/$MOUNT_UNIT"
systemctl daemon-reload
userdel "$OWNER"
if getent group "$OWNER" >/dev/null; then
  [[ $(getent group "$OWNER" | cut -d: -f3) == "$account_gid" ]] || fail 'same-name group changed during cleanup; preserve it'
  groupdel "$OWNER"
fi
sed -i "/^$OWNER:${SUBID_START}:${SUBID_COUNT}$/d" /etc/subuid /etc/subgid
rm -f "$IMAGE" "$MARKER"
rmdir "$MOUNT" "$BASE" 2>/dev/null || fail 'T14 directories contain unexpected data; preserve and inspect'
echo 'CLEANED: only marker-owned T14 test cluster/state/account removed; protected production BuildKit untouched.'
