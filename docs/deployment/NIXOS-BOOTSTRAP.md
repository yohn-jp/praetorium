# Existing NixOS guest bootstrap

Praetorium runs on two **existing** NixOS VMs in Proxmox, not by modifying the Proxmox host. See [first OS installation](NIXOS-INSTALL.md) for the one-time NixOS ISO/installer steps. The pinned role modules are under `infrastructure/nixos/modules/`.

From the same immutable Praetorium Git checkout on the Runtime VM, copy/fill `infrastructure/nixos/examples/runtime-host.nix` outside Git. Set the inventory's opaque `clusterId`, trusted admin CIDRs and SSH public key. Execute:

```sh
sudo bash scripts/bootstrap-linux.sh runtime /root/praetorium-runtime.nix --check
sudo bash scripts/bootstrap-linux.sh runtime /root/praetorium-runtime.nix --apply
```

On the Build VM, use `build /root/praetorium-build.nix` instead. Supply existing XFS storage, a protected mTLS certificate/key/CA root under `/run/secrets` or `/var/lib/praetorium/credentials`, source/egress CIDRs and bounded CPU/memory/tasks before switching. No disk is formatted and no TLS key is generated automatically.

The bootstrap preserves the installed `/etc/nixos/configuration.nix` and `hardware-configuration.nix`; it will only create/refresh a marked Praetorium-managed `/etc/nixos/flake.nix` and refuses to overwrite an unrelated flake or a different pre-existing role file. `--check` updates this local host flake/lock and builds without changing the activated OS. `--apply` switches the system only after a successful build. The package graph follows Praetorium's version-pinned NixOS module flake.

The Runtime role enables K3s, kubectl, Kustomize, Flux CLI, Git and Node 24. It marks the K3s node with the same opaque cluster ID that the deployment inventory must supply. After both hosts are bootstrapped, [deploy the four platform services and controllers](REPRODUCIBLE-DEPLOYMENT.md) in the same declarative inventory flow.

Do not place private keys in Nix expressions. Private credential files are independently managed on the guest, with the BuildKit systemd service referring to file paths rather than copying credentials into the Nix store.
