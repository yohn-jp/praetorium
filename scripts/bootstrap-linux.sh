#!/usr/bin/env bash
set -euo pipefail
# Bootstrap an existing NixOS guest without changing Proxmox or formatting disks.
# Usage: sudo bash scripts/bootstrap-linux.sh runtime|build /absolute/path/to/host.nix [--apply]
role="${1:-}"; host="${2:-}"; mode="${3:---check}"
if [[ "$role" != runtime && "$role" != build ]] || [[ "$host" != /* ]] || [[ "$mode" != --check && "$mode" != --apply ]]; then
  echo "Usage: sudo bash scripts/bootstrap-linux.sh runtime|build /absolute/path/to/host.nix [--check|--apply]" >&2; exit 2
fi
if [[ ! -f /etc/NIXOS ]] || ! command -v nix >/dev/null || ! command -v nixos-rebuild >/dev/null; then
  echo "Existing NixOS guest required; this does not install an OS or alter Proxmox." >&2; exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 2; fi
if [[ ! -f "$host" ]] || [[ -L "$host" ]]; then echo "Host module must be an existing regular file." >&2; exit 2; fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
flake="$root/infrastructure/nixos"
if [[ ! -f "$flake/flake.lock" ]]; then echo "Pinned flake.lock missing." >&2; exit 2; fi
# A private host module is supplied by the operator; no credentials are copied into the Nix store by this script.
if [[ "$role" == runtime ]]; then module=runtimeHost; else module=buildHost; fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/flake.nix" <<EOF
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  inputs.praetorium.url = "path:$flake";
  outputs = { nixpkgs, praetorium, ... }: {
    nixosConfigurations.praetorium = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        praetorium.nixosModules.$module
        $host
      ];
    };
  };
}
EOF
# The temporary flake intentionally has no lock: pin the local source input, and verify the chosen host role.
# Avoid writing the evaluated configuration to /etc/nixos or enabling services before explicit --apply.
echo "Evaluating $role host configuration..."
nix --extra-experimental-features 'nix-command flakes' eval --impure --raw "$tmp#nixosConfigurations.praetorium.config.system.build.toplevel.drvPath" >/dev/null
echo "Host configuration evaluation passed."
if [[ "$mode" == --apply ]]; then
  echo "Applying $role host configuration with nixos-rebuild switch..."
  nixos-rebuild switch --flake "$tmp#praetorium" --impure
else
  echo "No changes applied. Rerun with --apply after reviewing the host module."
fi
