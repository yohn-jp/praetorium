#!/usr/bin/env bash
set -euo pipefail

# Root-applied, bounded substrate for the T14 disposable Kind/BuildKit host.
# This does not alter the production BuildKit service or open host firewall ports.
readonly OWNER='praetorium-t14'
readonly BASE='/var/lib/praetorium-t14'
readonly IMAGE="$BASE/state.img"
readonly MOUNT="$BASE/state"
readonly MARKER="$BASE/owner.json"
readonly CLUSTER='praetorium-t14-canary'
readonly CONTEXT='kind-praetorium-t14-canary'
readonly MOUNT_UNIT='var-lib-praetorium\x2dt14-state.mount'
readonly SLICE_UNIT='praetorium-t14.slice'
readonly TEST_BUILDKIT_UNIT='praetorium-buildkit-t14.service'
readonly IMAGE_BYTES=6442450944
readonly SUBID_START=3000000
readonly SUBID_COUNT=65536
readonly EXPECTED_NODE_IMAGE='kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f'

usage() { echo "usage: $0 plan|setup|cleanup" >&2; exit 2; }
[[ $# == 1 ]] || usage
action=$1
[[ $action == plan || $action == setup || $action == cleanup ]] || usage

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"; }

check_subid_free() {
  local file=$1 start=$SUBID_START end=$((SUBID_START + SUBID_COUNT - 1))
  [[ -f $file ]] || return 0
  awk -F: -v s="$start" -v e="$end" '$2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { a=$2; b=$2+$3-1; if (s<=b && a<=e) exit 1 }' "$file" \
    || fail "subordinate ID range $start-$end overlaps an existing range in $file"
}

check_tools() {
  need systemctl; need podman; need kind; need kubectl; need node; need pnpm; need ss; need newuidmap; need newgidmap; need losetup; need realpath
  [[ $(podman --version) == 'podman version 5.7.0' ]] || fail 'Podman must be the observed apt version 5.7.0'
  [[ $(kind --version) == 'kind v0.31.0 '* ]] || fail 'Kind must be pinned to v0.31.0'
  [[ $(node --version) == v24.* ]] || fail 'Node must be v24'
  [[ $(pnpm --version) == 11.18.0 ]] || fail 'pnpm must be 11.18.0'
  kubectl version --client --output=json | grep -q '"gitVersion":"v1.35.0"' || fail 'kubectl must be pinned to v1.35.0'
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
  [[ $(df -B1 --output=avail / | tail -1 | tr -d ' ') -ge 10737418240 ]] || fail 'less than 10 GiB free on / for the preallocated image'
}

write_marker() {
  local uuid=$1 expires mount_hash slice_hash
  expires=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)
  mount_hash=$(sha256sum "/etc/systemd/system/$MOUNT_UNIT" | awk '{print $1}')
  slice_hash=$(sha256sum "/etc/systemd/system/$SLICE_UNIT" | awk '{print $1}')
  install -d -o root -g root -m 0700 "$BASE"
  printf '{"schema":"praetorium.t14-builder-owner/v1","owner":"%s","image":"%s","imageBytes":%s,"mount":"%s","mountUnit":"%s","mountUnitSha256":"%s","sliceUnit":"%s","sliceUnitSha256":"%s","testBuildkitUnit":"%s","filesystemUuid":"%s","cluster":"%s","context":"%s","buildkitHostPort":1235,"expiresAt":"%s"}\n' \
    "$OWNER" "$IMAGE" "$IMAGE_BYTES" "$MOUNT" "$MOUNT_UNIT" "$mount_hash" "$SLICE_UNIT" "$slice_hash" "$TEST_BUILDKIT_UNIT" "$uuid" "$CLUSTER" "$CONTEXT" "$expires" > "$MARKER"
  chmod 0600 "$MARKER"
  install -d -o root -g root -m 0700 "$MOUNT/.praetorium-t14"
  install -m 0600 -o root -g root "$MARKER" "$MOUNT/.praetorium-t14/owner.json"
}

verify_marker() {
  [[ -f $MARKER && ! -L $MARKER ]] || fail 'owner marker missing or symlinked'
  [[ $(stat -c '%u:%a' "$MARKER") == '0:600' ]] || fail 'owner marker must be root-owned mode 0600'
  python3 - "$MARKER" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]))
expected={'schema':'praetorium.t14-builder-owner/v1','owner':'praetorium-t14','image':'/var/lib/praetorium-t14/state.img','imageBytes':6442450944,'mount':'/var/lib/praetorium-t14/state','mountUnit':'var-lib-praetorium\\x2dt14-state.mount','sliceUnit':'praetorium-t14.slice','testBuildkitUnit':'praetorium-buildkit-t14.service','cluster':'praetorium-t14-canary','context':'kind-praetorium-t14-canary','buildkitHostPort':1235}
if any(p.get(k)!=v for k,v in expected.items()) or not p.get('filesystemUuid') or not p.get('expiresAt'):
    raise SystemExit('owner marker contract mismatch')
for key,path in [('mountUnitSha256','/etc/systemd/system/'+p['mountUnit']),('sliceUnitSha256','/etc/systemd/system/'+p['sliceUnit'])]:
    import hashlib,os,stat
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
  check_tools
  [[ ! -e $BASE && ! -L $BASE && ! -e $MARKER && ! -L $MARKER && ! -e $IMAGE && ! -L $IMAGE && ! -e $MOUNT && ! -L $MOUNT ]] || fail 'T14 state already exists; inspect ownership marker before proceeding'
  [[ $(systemctl show "$TEST_BUILDKIT_UNIT" -p LoadState --value 2>/dev/null || true) == not-found ]] || fail 'T14 BuildKit unit name is already occupied; refusing to adopt it'
  check_subid_free /etc/subuid; check_subid_free /etc/subgid
  printf 'READY: rootless test account=%s subids=%s:%s state=%s bytes=%s cgroup=2CPU/4GiB/2048tasks BuildKit=10.7.0.32:1235 protected=10.7.0.32:1234 cluster=%s node=%s\n' \
    "$OWNER" "$SUBID_START" "$SUBID_COUNT" "$IMAGE" "$IMAGE_BYTES" "$CLUSTER" "$EXPECTED_NODE_IMAGE"
  exit 0
fi

(( EUID == 0 )) || fail "$action requires root"

if [[ $action == setup ]]; then
  check_tools
  [[ ! -e $BASE && ! -L $BASE && ! -e $MARKER && ! -L $MARKER && ! -e $IMAGE && ! -L $IMAGE && ! -e $MOUNT && ! -L $MOUNT ]] || fail 'T14 paths already exist; refusing to adopt unmarked state'
  [[ $(systemctl show "$TEST_BUILDKIT_UNIT" -p LoadState --value 2>/dev/null || true) == not-found ]] || fail 'T14 BuildKit unit name is already occupied; refusing to adopt it'
  check_subid_free /etc/subuid; check_subid_free /etc/subgid
  [[ -x /usr/bin/fallocate && -x /usr/sbin/mkfs.ext4 ]] || fail 'fallocate/mkfs.ext4 unavailable'
  getent passwd "$OWNER" >/dev/null && fail "account $OWNER already exists without this owner marker"
  install -d -o root -g root -m 0700 "$BASE" "$MOUNT"
  useradd --system --home-dir "$MOUNT/home" --shell /usr/sbin/nologin "$OWNER"
  usermod --add-subuids "$SUBID_START-$((SUBID_START + SUBID_COUNT - 1))" "$OWNER"
  usermod --add-subgids "$SUBID_START-$((SUBID_START + SUBID_COUNT - 1))" "$OWNER"
  fallocate -l "$IMAGE_BYTES" "$IMAGE"
  chmod 0600 "$IMAGE"
  mkfs.ext4 -F -q "$IMAGE"
  local_uuid=$(blkid -s UUID -o value "$IMAGE")
  cat > "/etc/systemd/system/$MOUNT_UNIT" <<EOF
[Unit]
Description=Praetorium T14 bounded disposable state
Before=praetorium-t14.slice

[Mount]
What=$IMAGE
Where=$MOUNT
Type=ext4
Options=loop,nodev,nosuid

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "/etc/systemd/system/$MOUNT_UNIT"
  cat > "/etc/systemd/system/$SLICE_UNIT" <<'EOF'
[Unit]
Description=Praetorium T14 disposable resource ceiling

[Slice]
CPUAccounting=yes
CPUQuota=200%
MemoryAccounting=yes
MemoryMax=4G
TasksAccounting=yes
TasksMax=2048
Delegate=yes
EOF
  chmod 0644 "/etc/systemd/system/$SLICE_UNIT"
  systemctl daemon-reload
  systemctl enable --now "$MOUNT_UNIT"
  write_marker "$local_uuid"
  chown "$OWNER:$OWNER" "$MOUNT"
  install -d -o "$OWNER" -g "$OWNER" -m 0700 "$MOUNT/home" "$MOUNT/podman" "$MOUNT/kube" "$MOUNT/logs" "$MOUNT/credentials"
  install -d -o "$OWNER" -g "$OWNER" -m 0700 "$MOUNT/home/.config/containers"
  cat > "$MOUNT/home/.config/containers/storage.conf" <<EOF
[storage]
driver = "overlay"
graphroot = "$MOUNT/podman/graphroot"
runroot = "/run/user/$(id -u "$OWNER")/containers"
EOF
  chmod 0600 "$MOUNT/home/.config/containers/storage.conf"
  chown "$OWNER:$OWNER" "$MOUNT/home/.config/containers/storage.conf"
  install -d -o "$OWNER" -g "$OWNER" -m 0700 "/run/user/$(id -u "$OWNER")" "/run/user/$(id -u "$OWNER")/containers"
  verify_marker
  echo "READY: T14 host substrate created. No Kind cluster or workload started; use canonical deploy-infrastructure runner."
  exit 0
fi

verify_marker
getent passwd "$OWNER" >/dev/null || fail 'owned test account is missing; do not infer ownership'
need kind; need podman
test_uid=$(id -u "$OWNER")
if [[ ! -f /etc/subuid || $(grep -Fc "$OWNER:$SUBID_START:$SUBID_COUNT" /etc/subuid) != 1 || ! -f /etc/subgid || $(grep -Fc "$OWNER:$SUBID_START:$SUBID_COUNT" /etc/subgid) != 1 ]]; then
  fail 'disposable account subordinate ID records differ from the exact allocated range'
fi
if systemctl is-active --quiet "$TEST_BUILDKIT_UNIT"; then fail 'T14 BuildKit unit is active; stop and verify it separately before substrate cleanup'; fi
clusters=$(runuser -u "$OWNER" -- env HOME="$MOUNT/home" XDG_CONFIG_HOME="$MOUNT/home/.config" \
    XDG_DATA_HOME="$MOUNT/home/.local/share" XDG_RUNTIME_DIR="/run/user/$test_uid" \
    CONTAINERS_STORAGE_CONF="$MOUNT/home/.config/containers/storage.conf" \
    KIND_EXPERIMENTAL_PROVIDER=podman kind get clusters)
if grep -Fxq "$CLUSTER" <<<"$clusters"; then
  runuser -u "$OWNER" -- env HOME="$MOUNT/home" XDG_CONFIG_HOME="$MOUNT/home/.config" \
    XDG_DATA_HOME="$MOUNT/home/.local/share" XDG_RUNTIME_DIR="/run/user/$test_uid" \
    CONTAINERS_STORAGE_CONF="$MOUNT/home/.config/containers/storage.conf" \
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
find "$MOUNT" -xdev -mindepth 1 -depth -delete
systemctl disable --now "$MOUNT_UNIT"
[[ $(findmnt -rn -o TARGET --target "$MOUNT" 2>/dev/null || true) != "$MOUNT" ]] || fail 'owned state is still mounted after unit stop'
rm -f "/etc/systemd/system/$SLICE_UNIT" "/etc/systemd/system/$MOUNT_UNIT"
systemctl daemon-reload
userdel "$OWNER"
sed -i "/^$OWNER:${SUBID_START}:${SUBID_COUNT}$/d" /etc/subuid /etc/subgid
rm -f "$IMAGE" "$MARKER"
rmdir "$MOUNT" "$BASE" 2>/dev/null || fail 'T14 directories contain unexpected data; preserve and inspect'
echo 'CLEANED: only marker-owned T14 test cluster/state/account removed; protected production BuildKit untouched.'
