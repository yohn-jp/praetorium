# Existing NixOS guest bootstrap

This bootstrap runs **inside** an already installed NixOS VM. It does not provision Proxmox, install Linux, format BuildKit disks, provision Cloudflare, deploy application workloads or generate secrets. It consumes the existing role modules under `infrastructure/nixos/modules/` and requires an operator-supplied host module with all mandatory parameters.

```sh
sudo bash scripts/bootstrap-linux.sh runtime /root/praetorium-runtime-host.nix --check
sudo bash scripts/bootstrap-linux.sh runtime /root/praetorium-runtime-host.nix --apply
```

For the separate BuildKit VM, use `build` and a host module enabling `praetorium.buildHost`. The existing BuildKit module **requires** an already-provisioned XFS device, client and egress CIDRs, proxy, TLS credential paths and fixed resource limits. It intentionally does not format storage or mint mTLS credentials.

The operator module is a NixOS module, not a complete flake. The bootstrap creates a temporary flake that imports the pinned Praetorium NixOS role and the operator module. The script refuses non-NixOS hosts and only performs a switch with explicit `--apply`. Because the temporary flake has a separate lock resolution, verify the evaluated package revisions before production use; the role module source is the checked-out repository.

This is **host bootstrap only**, not one-command end-to-end Praetorium deployment. Runtime secrets, Flux workload application and full Hosted acceptance remain separate. Avoid putting private key contents directly in Nix expressions; refer to runtime-only paths instead.
