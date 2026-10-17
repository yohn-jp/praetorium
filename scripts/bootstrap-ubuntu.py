#!/usr/bin/env python3
"""Additive Ubuntu 24.04 host bootstrap. --check makes no changes.

Only fresh, dedicated VMs are accepted. No disk formatting, firewall rewrites,
SSH configuration, production deployment or existing service replacement.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time

ROLE_MARKER = Path("/etc/praetorium/ubuntu-role.json")
BUILD_ROOT = Path("/var/lib/praetorium-buildkit")
BUILD_CONFIG = Path("/etc/praetorium/buildkitd.toml")
BUILD_UNIT = Path("/etc/systemd/system/praetorium-buildkit.service")
APPARMOR_PROFILE = Path("/etc/apparmor.d/praetorium-rootlesskit")
K3S_CONFIG = Path("/etc/rancher/k3s/config.yaml")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def execute(*argv, env=None):
    subprocess.run(argv, check=True, env=env)


def output(*argv):
    return subprocess.check_output(argv, text=True, stderr=subprocess.STDOUT).strip()


def only_keys(mapping, allowed, name):
    require(isinstance(mapping, dict) and set(mapping) == set(allowed),
            name + " requires exactly: " + ", ".join(allowed))


def concrete(value, label):
    require(isinstance(value, str) and len(value) > 0 and
            re.fullmatch(r"[A-Za-z0-9._/@:+%-]+", value) and
            not any(x in value.lower() for x in ("placeholder", "changeme", "example", "todo")),
            label + " must be concrete and free of shell metacharacters")
    return value


def private_ipv4(value, label):
    address = ipaddress.ip_address(concrete(value, label))
    require(isinstance(address, ipaddress.IPv4Address) and
                        any(address in ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")),
            label + " must be a private IPv4 host address")
    return str(address)


def cidrs(values, label):
    require(isinstance(values, list) and values, label + " must be nonempty")
    for value in values:
        subnet = ipaddress.ip_network(concrete(value, label), strict=True)
        forbidden = tuple(ipaddress.ip_network(x) for x in (
            "0.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
            "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24",
            "224.0.0.0/4", "240.0.0.0/4"
        ))
        require(isinstance(subnet, ipaddress.IPv4Network) and
                not subnet.is_multicast and not subnet.is_reserved and
                (subnet.prefixlen >= 16 or subnet.is_private) and
                not any(subnet.overlaps(blocked) for blocked in forbidden),
                label + " must contain explicit safe IPv4 CIDRs (public /16 or narrower)")
    require(len(values) == len(set(values)), label + " contains duplicates")
    return values


def owned_file(filename, label, secret=False):
    require(isinstance(filename, str) and filename.startswith("/"), label + " must be absolute")
    path = Path(filename)
    require(re.fullmatch(r"/[A-Za-z0-9._/-]+", filename) and
            ".." not in path.parts and not path.is_symlink() and path.is_file(),
            label + " must be a safe regular file path")
    if secret:
        require(path.stat().st_uid == 0 and (path.stat().st_mode & 0o077) == 0,
                label + " must be root-owned with no group/other permission")
    return path


def sha256_matches(path, digest):
    require(re.fullmatch(r"[a-f0-9]{64}", digest or ""), "expected a pinned SHA256")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    require(h.hexdigest() == digest, "SHA256 mismatch: " + str(path))


def executable(name):
    found = shutil.which(name)
    require(found and Path(found).is_file(), "missing preinstalled tool: " + name)
    return found


def host_preflight(role):
    os_release = dict(
        line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines()
        if "=" in line
    )
    require(os_release.get("ID", "").strip('"') == "ubuntu" and
            os_release.get("VERSION_ID", "").strip('"') == "24.04",
            "Ubuntu 24.04 LTS is required")
    require(os.uname().machine == "x86_64", "only x86_64 supported")
    require(not ROLE_MARKER.exists(), "existing Praetorium Ubuntu role; refusing to reconfigure")
    require(not (Path("/etc/NIXOS").exists()), "NixOS must use the existing bootstrap")
    require(shutil.which("systemctl") is not None, "systemd required")
    require(not (Path("/etc/praetorium/buildkitd.toml").exists() if role == "runtime" else
                 Path("/usr/local/bin/k3s").exists()),
            "opposite role partial installation detected")
    other = ("praetorium-buildkit" if role == "runtime" else "k3s")
    require(output("systemctl", "show", "-p", "LoadState", "--value", other + ".service") == "not-found",
            "opposite role service exists: " + other)
    require(not Path("/var/lib/rancher/k3s").exists() if role == "runtime" else
            not Path("/etc/rancher/k3s").exists(),
            "existing Kubernetes state; use a fresh dedicated VM")


def free_port(address, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((address, port))
        except OSError as exc:
            raise ValueError("requested listener unavailable: " + str(exc)) from exc


def interface_address(address):
    entries = json.loads(output("ip", "-j", "-4", "address", "show"))
    require(any(item.get("local") == address for iface in entries for item in iface.get("addr_info", [])),
            "bind address is not assigned to this VM")


def runtime_preflight(config):
    only_keys(config, ["role", "clusterId", "bindAddress", "tlsSans",
                       "k3sVersion", "k3sBinary", "k3sBinarySha256",
                       "installer", "installerSha256"], "runtime config")
    require(re.fullmatch(r"clu_[0-9A-HJKMNP-TV-Z]{26}", config["clusterId"] or ""),
            "invalid clusterId")
    address = private_ipv4(config["bindAddress"], "bindAddress")
    interface_address(address)
    require(isinstance(config["tlsSans"], list) and
            all(re.fullmatch(r"[A-Za-z0-9.-]{1,253}", x) for x in config["tlsSans"]),
            "tlsSans must be a list of literal DNS names / IPs")
    require(re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+", config["k3sVersion"] or ""),
            "k3sVersion must be an exact release (not a channel)")
    binary = owned_file(config["k3sBinary"], "k3sBinary")
    installer = owned_file(config["installer"], "installer")
    sha256_matches(binary, config["k3sBinarySha256"])
    sha256_matches(installer, config["installerSha256"])
    require(config["k3sVersion"] in output(str(binary), "--version"), "staged K3s binary version mismatch")
    require(not Path("/usr/local/bin/k3s").exists() and
            not K3S_CONFIG.parent.exists() and
            output("systemctl", "show", "-p", "LoadState", "--value", "k3s.service") == "not-found",
            "existing K3s installation must not be overwritten")
    free_port(address, 6443)


def build_preflight(config):
    only_keys(config, ["role", "bindAddress", "listenPort", "clientCidrs",
                       "egressCidrs", "egressProxyUrl", "tls",
                       "quotaMiB", "cpuQuota", "memoryMax", "tasksMax"], "build config")
    address = private_ipv4(config["bindAddress"], "bindAddress")
    interface_address(address)
    require(type(config["listenPort"]) is int and 1024 <= config["listenPort"] <= 65535,
            "listenPort must be a nonprivileged TCP port")
    free_port(address, config["listenPort"])
    cidrs(config["clientCidrs"], "clientCidrs")
    cidrs(config["egressCidrs"], "egressCidrs")
    proxy = concrete(config["egressProxyUrl"], "egressProxyUrl")
    require(re.fullmatch(r"https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?", proxy),
            "proxy must be an origin without credentials/path")
    only_keys(config["tls"], ["serverCertFile", "serverKeyFile", "clientCaFile"], "tls")
    for label, filename in config["tls"].items():
        require(filename.startswith(("/run/secrets/", "/var/lib/praetorium/credentials/")),
                "TLS files must be outside Git in protected credential paths")
        owned_file(filename, label, secret=True)
    # Verify cert material, matching server private key, and the private bind IP.
    executable("openssl")
    cert = config["tls"]["serverCertFile"]
    key = config["tls"]["serverKeyFile"]
    execute("openssl", "x509", "-in", cert, "-checkend", "3600", "-noout")
    execute("openssl", "x509", "-in", config["tls"]["clientCaFile"], "-noout")
    execute("openssl", "x509", "-in", cert, "-checkip", address, "-noout")
    pub_from_cert = output("openssl", "x509", "-in", cert, "-pubkey", "-noout")
    pub_from_key = output("openssl", "pkey", "-in", key, "-pubout")
    require(pub_from_cert == pub_from_key, "server certificate and private key do not match")
    require(type(config["quotaMiB"]) is int and 1024 <= config["quotaMiB"] <= 1048576,
            "quotaMiB outside bounded range")
    require(isinstance(config["cpuQuota"], str) and re.fullmatch(r"[1-9][0-9]{0,3}%", config["cpuQuota"]), "invalid cpuQuota")
    require(isinstance(config["memoryMax"], str) and re.fullmatch(r"[1-9][0-9]{0,5}[MGT]", config["memoryMax"]), "invalid memoryMax")
    require(type(config["tasksMax"]) is int and 16 <= config["tasksMax"] <= 4096, "invalid tasksMax")
    for tool in ("rootlesskit", "slirp4netns", "buildkitd", "xfs_quota",
                 "apparmor_parser", "useradd", "getent"):
        executable(tool)
    require(BUILD_ROOT.is_mount(), "dedicated XFS cache must already be mounted; never formats disks")
    require(not any(BUILD_ROOT.iterdir()), "dedicated BuildKit cache is not empty; refusing to relabel existing data")
    require(not Path("/var/run/docker.sock").exists(), "privileged Docker socket exists on BuildKit host")
    mount = output("findmnt", "-n", "-o", "FSTYPE,OPTIONS", "--mountpoint", str(BUILD_ROOT))
    require(mount.startswith("xfs ") and
            any(x in mount.split(" ", 1)[1].split(",") for x in ("prjquota", "pquota")),
            "XFS project quota must be enabled on the dedicated mount")
    require(not Path("/etc/projects").exists() and not Path("/etc/projid").exists(),
            "existing XFS project mappings require operator review, refusing overwrite")
    require(not BUILD_CONFIG.exists() and not BUILD_UNIT.exists() and not APPARMOR_PROFILE.exists(),
            "existing BuildKit/Praetorium config; refusing replacement")
    require(subprocess.run(["getent", "passwd", "buildkit"], capture_output=True).returncode != 0,
            "existing buildkit account; refusing to reuse")
    # Ubuntu's global unprivileged userns mitigation must not be weakened here.
    setting = Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
    require(setting.is_file() and setting.read_text().strip() == "1",
            "expected enabled Ubuntu AppArmor userns restriction; do not weaken it globally")


def write_new(path, content, mode=0o644):
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        stream.write(content)
    path.chmod(mode)


def apply_runtime(config):
    K3S_CONFIG.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    write_new(K3S_CONFIG, json.dumps({
        "disable": ["traefik"],
        "cluster-init": True,
        "bind-address": config["bindAddress"],
        "advertise-address": config["bindAddress"],
        "node-label": ["praetorium.io/cluster-id=" + config["clusterId"]],
        "write-kubeconfig-mode": "0640",
        "tls-san": [config["bindAddress"]] + config["tlsSans"],
    }, indent=2) + "\n", mode=0o600)
    # The staged installer and binary were SHA256-checked during preflight.
    shutil.copyfile(config["k3sBinary"], "/usr/local/bin/k3s")
    Path("/usr/local/bin/k3s").chmod(0o755)
    env = {**os.environ, "INSTALL_K3S_SKIP_DOWNLOAD": "true",
           "INSTALL_K3S_SKIP_START": "true", "INSTALL_K3S_SKIP_ENABLE": "true",
           "INSTALL_K3S_EXEC": "server", "INSTALL_K3S_SYMLINK": "skip"}
    execute("/bin/sh", config["installer"], env=env)
    execute("systemctl", "enable", "--now", "k3s.service")
    # New embedded-etcd clusters need a bounded startup grace period.
    for attempt in range(30):
        try:
            nodes = json.loads(output("/usr/local/bin/k3s", "kubectl", "get", "nodes",
                                      "-l", "praetorium.io/cluster-id=" + config["clusterId"],
                                      "-o", "json", "--request-timeout=5s"))
            if nodes.get("items") and all(
                any(c.get("type") == "Ready" and c.get("status") == "True"
                    for c in node.get("status", {}).get("conditions", []))
                for node in nodes["items"]
            ):
                break
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            pass
        time.sleep(5)
    else:
        raise ValueError("K3s node with declared cluster identity did not become Ready")


def apply_build(config):
    rootlesskit = executable("rootlesskit")
    slirp4netns = executable("slirp4netns")
    buildkitd = executable("buildkitd")
    execute("useradd", "--system", "--user-group", "--create-home", "-F",
            "--home-dir", str(BUILD_ROOT), "--shell", "/usr/sbin/nologin", "buildkit")
    for filename in ("/etc/subuid", "/etc/subgid"):
        entries = Path(filename).read_text().splitlines()
        require(any(line.startswith("buildkit:") for line in entries),
                "buildkit subordinate IDs missing after user creation: " + filename)
    write_new(Path("/etc/projects"), "2001:" + str(BUILD_ROOT) + "\n")
    write_new(Path("/etc/projid"), "praetorium-buildkit:2001\n")
    execute("xfs_quota", "-x", "-c", "project -s praetorium-buildkit",
            "-c", "limit -p bhard=" + str(config["quotaMiB"]) + "m praetorium-buildkit",
            str(BUILD_ROOT))
    state = BUILD_ROOT / "state"
    state.mkdir(mode=0o700, exist_ok=False)
    execute("chown", "-R", "buildkit:buildkit", str(state))
    tls = config["tls"]
    write_new(BUILD_CONFIG, "\n".join([
        'root = "' + str(state) + '"',
        'proxyNetwork = true', '',
        '[grpc]',
        '  address = ["tcp://0.0.0.0:' + str(config["listenPort"]) + '"]',
        '  [grpc.tls]',
        '    cert = "/run/credentials/praetorium-buildkit.service/server.crt"',
        '    key = "/run/credentials/praetorium-buildkit.service/server.key"',
        '    ca = "/run/credentials/praetorium-buildkit.service/client-ca.crt"',
        '[worker.oci]', '  rootless = true',
        '  max-parallelism = 1', '  gc = true',
        '  maxUsedSpace = ' + str(config["quotaMiB"] * 1024 * 1024),
        '  reservedSpace = "5%"', ''
    ]))
    # Path-scoped AppArmor accommodation, not a host-wide sysctl disable.
    write_new(APPARMOR_PROFILE, "\n".join([
        "abi <abi/4.0>,", "include <tunables/global>", "",
        rootlesskit + " flags=(unconfined) {", "  userns,", "}", ""
    ]))
    execute("apparmor_parser", "-r", str(APPARMOR_PROFILE))
    port = str(config["listenPort"])
    allow = " ".join(config["clientCidrs"] + config["egressCidrs"] +
                     ["127.0.0.0/8", "::1/128"])
    command = (" ".join([rootlesskit, "--net=slirp4netns",
               "--slirp4netns-binary=" + slirp4netns,
               "--disable-host-loopback", "--port-driver=builtin",
               "--publish-port=" + config["bindAddress"] + ":" + port + ":" + port + "/tcp",
               buildkitd, "--config=" + str(BUILD_CONFIG), "--rootless"]))
    write_new(BUILD_UNIT, "\n".join([
        "[Unit]", "Description=Praetorium isolated rootless mTLS BuildKit",
        "Wants=network-online.target", "After=network-online.target",
        "RequiresMountsFor=" + str(BUILD_ROOT), "",
        "[Service]", "User=buildkit", "Group=buildkit",
        "WorkingDirectory=" + str(BUILD_ROOT),
        "RuntimeDirectory=praetorium-buildkit", "RuntimeDirectoryMode=0700",
        "Environment=XDG_RUNTIME_DIR=/run/praetorium-buildkit",
        "Environment=HTTP_PROXY=" + config["egressProxyUrl"],
        "Environment=HTTPS_PROXY=" + config["egressProxyUrl"],
        "LoadCredential=server.crt:" + tls["serverCertFile"],
        "LoadCredential=server.key:" + tls["serverKeyFile"],
        "LoadCredential=client-ca.crt:" + tls["clientCaFile"],
        "ExecStart=" + command,
        "Restart=on-failure", "RestartSec=5s",
        "CPUQuota=" + config["cpuQuota"],
        "MemoryMax=" + config["memoryMax"],
        "TasksMax=" + str(config["tasksMax"]),
        "CapabilityBoundingSet=CAP_SETUID CAP_SETGID",
        "DevicePolicy=closed", "DeviceAllow=/dev/net/tun rw",
        "PrivateTmp=true", "ProtectHome=true", "ProtectSystem=strict",
        "ReadWritePaths=" + str(BUILD_ROOT) + " /run/praetorium-buildkit",
        "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
        "IPAddressDeny=any", "IPAddressAllow=" + allow,
        "UMask=0077", "",
        "[Install]", "WantedBy=multi-user.target", ""
    ]))
    execute("systemctl", "daemon-reload")
    execute("systemctl", "enable", "--now", "praetorium-buildkit.service")
    for attempt in range(12):
        if (subprocess.run(["systemctl", "is-active", "--quiet",
                            "praetorium-buildkit.service"]).returncode == 0):
            try:
                with socket.create_connection(
                    (config["bindAddress"], config["listenPort"]), timeout=2
                ):
                    break
            except OSError:
                pass
        time.sleep(2)
    else:
        raise ValueError("BuildKit service did not become reachable on its private mTLS listener")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=("runtime", "build"))
    parser.add_argument("config", help="absolute path to operator-owned JSON")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-host", help="required for --apply; must match hostname")
    args = parser.parse_args()
    require(os.geteuid() == 0, "run as root, including --check")
    require(Path(args.config).is_absolute(), "config path must be absolute")
    config_path = owned_file(args.config, "config", secret=True)
    def reject_duplicates(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON configuration key: " + key)
            result[key] = value
        return result
    config = json.loads(config_path.read_text(encoding="utf-8"),
                        object_pairs_hook=reject_duplicates)
    require(isinstance(config, dict) and config.get("role") == args.role,
            "config role mismatch")
    host_preflight(args.role)
    if args.role == "runtime":
        runtime_preflight(config)
    else:
        build_preflight(config)
    print("PASS: Ubuntu " + args.role + " preflight (read-only)")
    if args.check:
        return
    require(args.confirm_host == socket.gethostname(),
            "--apply requires --confirm-host matching the exact hostname")
    if args.role == "runtime":
        apply_runtime(config)
    else:
        apply_build(config)
    ROLE_MARKER.parent.mkdir(parents=True, exist_ok=True)
    write_new(ROLE_MARKER, json.dumps({
        "role": args.role, "hostname": socket.gethostname(),
        "configSha256": hashlib.sha256(config_path.read_bytes()).hexdigest(),
    }, indent=2) + "\n", 0o600)
    print("Applied Ubuntu role. Static platform deploy and integration acceptance are separate.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print("BLOCKED: " + str(exc), file=sys.stderr)
        sys.exit(1)
