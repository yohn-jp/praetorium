# Ubuntu 24.04 host bootstrap (two dedicated VMs)

This is an **additive alternative** to the NixOS host roles. The existing
Cloudflare/K3s deployment inventory, Render/Kustomize/Flux manifests, Node
services, and `scripts/deploy-platform.mjs` are unchanged. Both guests must be
**new, dedicated Ubuntu Server 24.04 LTS x86_64 VMs**, on a privately managed
network. Do not run this on Proxmox, an existing shared Ubuntu host, or a host
with application workloads. No changes to NixOS roles are required.

| Guest | Role | Bootstrapped service |
| --- | --- | --- |
| Runtime | `runtime` | K3s server (Traefik disabled; declared by Flux), cluster identity label |
| Build | `build` | Rootless BuildKit with mTLS, bounded XFS cache and systemd limits |

No VM/disk creation, disk formatting, SSH, UFW, DNS, external ingress, trust-key
generation, container publication or production delivery is performed. The
operator is responsible for private reachability, firewall policy (SSH and K3s
API restricted to management ranges; BuildKit endpoint restricted to the
Build Worker source CIDRs), and maintaining a recovery console. In particular,
this bootstrap does **not** automatically modify any host firewall, sysctl or
AppArmor global setting.

## Inputs (never commit)

On both VMs, checkout the same reviewed immutable Praetorium commit.

Copy the corresponding template to a **root-owned 0600 file outside Git**:
`/root/praetorium-runtime.json` or `/root/praetorium-build.json`.
A null/empty template is intentionally rejected. The inventory's `clusterId`
must match the Runtime file's `clusterId`. The public-facing instance-domain
TLS/edge arrangement is a separate explicit prerequisite; Kubernetes TLS does
not provision the Cloudflare edge certificate.

### Runtime

Supply:

- An assigned *private IPv4 address* as `bindAddress`; expose TCP/6443 only on
  the approved management network. `tlsSans` is the literal DNS/IP SAN list.
- An exact K3s release (`k3sVersion`, such as a `vX.Y.Z+k3sN` release), an
  already downloaded upstream K3s binary and upstream K3s `install.sh`,
  and independently verified SHA256 values for **both**. Prefer a vendor-signed
  release and store pinned artifacts under `/root/praetorium-bootstrap`.
  Verify provenance before writing the private JSON; hashing an untrusted
  download and trusting its own newly computed hash is not verification.
- Do not stage into `/usr/local/bin/k3s`; the bootstrap refuses to replace
  an existing binary or K3s service.

The bootstrap verifies both SHA256s, checks the binary's exact version, writes
the K3s configuration under `/etc/rancher/k3s` and executes the staged,
reviewed installer with `INSTALL_K3S_SKIP_DOWNLOAD=true`. It never executes a
network-fetched shell pipe or installs an unpinned latest channel. The K3s
service is started only after the installer has created its service. It
disables bundled Traefik (the existing Flux HelmRelease owns Traefik).

### Build

Before bootstrap, the operator must provision **a separate existing XFS
filesystem**, already mounted at `/var/lib/praetorium-buildkit` with
`prjquota`/ `pquota` enabled. The script refuses to format disks or
repurpose a root filesystem. Ensure a project ID of 2001 is reserved for this
new dedicated VM (the bootstrap refuses existing `/etc/projects` or
`/etc/projid` mappings).

Install the reviewed and pinned `buildkitd`, `rootlesskit` and
`slirp4netns` executables (plus `xfsprogs`, `uidmap`,
`apparmor-utils`/parser, `iproute2`, `python3`). Do not use mutable
`latest` binaries. Fill the operator input JSON with:

- Private listening IPv4 address and TCP port; both Build Worker *client CIDRs*
  and approved build-input/proxy/registry *egress CIDRs*.
- A credential-free `http[s]://host[:port]` egress proxy origin. The proxy
  must be reachable within the egress CIDRs.
- Root-owned 0600 server certificate, private key and trusted client CA files,
  strictly outside Git in `/run/secrets` or
  `/var/lib/praetorium/credentials`. The Build Worker uses its own separate
  operator-provisioned **client** mTLS certificate and key.
- The hard project quota in MiB, `cpuQuota` (systemd percentage), `memoryMax`
  (systemd memory limit), and `tasksMax` (integer).

This BuildKit service does not receive K3s credentials, a privileged Docker
socket, GitHub tokens or signing keys. Ubuntu 24.04 normally confines
unprivileged user namespaces. This bootstrap installs a **path-specific**
AppArmor rule for `rootlesskit`; it refuses an already globally weakened
`kernel.apparmor_restrict_unprivileged_userns=0` configuration. It does not
disable AppArmor globally. <https://github.com/moby/buildkit/blob/master/docs/rootless.md>

## Nonmutating preflight, then explicit apply

Run the following on the matching guest **from a clean, detached checkout**.
Inspect the input, private network ACLs and guest-console recovery access
before `--apply`.

```sh
sudo python3 scripts/bootstrap-ubuntu.py runtime /root/praetorium-runtime.json --check
sudo python3 scripts/bootstrap-ubuntu.py runtime /root/praetorium-runtime.json --apply --confirm-host "$(hostname)"
```

On the separate Build VM:

```sh
sudo python3 scripts/bootstrap-ubuntu.py build /root/praetorium-build.json --check
sudo python3 scripts/bootstrap-ubuntu.py build /root/praetorium-build.json --apply --confirm-host "$(hostname)"
```

`--check` reads and verifies only. `--apply` refuses existing role/OS
installation state, the opposite role service, an occupied listener, missing
pinned inputs, and wrong hostname. **Apply is not transactional**: an
installer failure may leave a partial new-guest configuration; it will *not*
delete/rebuild pre-existing host state or silently retry. Inspect the failure
on that VM's console, reconcile partial effects, and use a clean VM if
necessary. Subsequent mismatched configuration does not automatically
overwrite managed files.

Check after apply:

```sh
sudo systemctl is-active k3s
sudo k3s kubectl get nodes --show-labels
# Build VM:
sudo systemctl is-active praetorium-buildkit
sudo journalctl -u praetorium-buildkit -n 50 --no-pager
```

The K3s node must report `praetorium.io/cluster-id` with the same value as
the deployment inventory; the BuildKit mTLS endpoint must be reachable **only**
from approved Build Workers. Independently verify the server certificate,
client rejection without a trusted certificate, proxy egress restrictions and
rootless UID before considering the Build service accepted.

## Platform deployment (unchanged)

From an authorized operator workstation with Node 24.21+, pnpm 11.18,
`kubectl`, Flux CLI, pinned package dependencies, Cloudflare authorization,
complete private inventory and Secret files:

```sh
node scripts/deploy-platform.mjs \
  --inventory /root/praetorium/deployment.json \
  --secret-files /root/praetorium/secret-files.json \
  --kubeconfig /root/praetorium/kubeconfig \
  --confirm praetorium-runtime --check
# Only after BOTH the host check and deployment preflight pass:
node scripts/deploy-platform.mjs \
  --inventory /root/praetorium/deployment.json \
  --secret-files /root/praetorium/secret-files.json \
  --kubeconfig /root/praetorium/kubeconfig \
  --confirm praetorium-runtime --apply
```

The static deployment command still requires reviewed immutable container
digests, signing identities, working Cloudflare bindings, owner-supplied
secrets and actual network reachability; no placeholder is silently filled.
A successful static deployment is **not** Hosted integration certification.
See [reproducible deployment](REPRODUCIBLE-DEPLOYMENT.md) for its exact gates
and [hosted integration](../verification/HOSTED-INTEGRATION-RUNBOOK.md) for
separate real-runtime acceptance.
