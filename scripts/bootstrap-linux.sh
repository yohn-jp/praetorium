#!/usr/bin/env bash
set -euo pipefail

# Apply the pinned Praetorium NixOS role to an existing guest. Never touches Proxmox.
usage() { echo 'Usage: sudo bash scripts/bootstrap-linux.sh runtime|build /absolute/path/to/host-role.nix [--check|--apply]' >&2; exit 2; }
[[ $# -ge 2 && $# -le 3 ]] || usage
role="$1"; operator_module="$2"; mode="${3:---check}"
[[ "$role" == runtime || "$role" == build ]] || usage
[[ "$mode" == --check || "$mode" == --apply ]] || usage
[[ "$operator_module" == /* && -f "$operator_module" && ! -L "$operator_module" ]] || usage
[[ -f /etc/NIXOS && -r /etc/nixos/configuration.nix && -r /etc/nixos/hardware-configuration.nix ]] || {
  echo 'NixOS installed with /etc/nixos/configuration.nix and hardware-configuration.nix is required' >&2; exit 2;
}
[[ "$(id -u)" == 0 ]] || { echo 'Run with sudo' >&2; exit 2; }
command -v nix >/dev/null && command -v nixos-rebuild >/dev/null || {
  echo 'Nix CLI and nixos-rebuild are required' >&2; exit 2;
}
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
role_flake="$root/infrastructure/nixos"
[[ -f "$role_flake/flake.lock" ]] || { echo 'Pinned role flake.lock missing' >&2; exit 2; }
case "$role" in
  runtime) module=runtimeHost ;;
  build) module=buildHost ;;
esac
target=/etc/nixos/praetorium-role.nix
flake=/etc/nixos/flake.nix
marker='# Managed by Praetorium guest bootstrap; keep configuration.nix and hardware config separately.'
# Do not overwrite a pre-existing personal flake or host role.
if [[ -e "$flake" ]] && ! grep -Fqx "$marker" "$flake"; then
  echo 'Existing /etc/nixos/flake.nix is not Praetorium-managed; integrate the role module into it manually.' >&2
  exit 2
fi
if [[ -e "$target" ]] && ! cmp -s "$operator_module" "$target"; then
  echo 'Existing role input differs from supplied module. Review/remove old /etc/nixos/praetorium-role.nix before retry.' >&2
  exit 2
fi
if [[ ! -e "$target" ]]; then
  install -m 0644 "$operator_module" "$target"
fi
cat > "$flake" <<EOF
$marker
{
  description = "Praetorium pinned NixOS $role guest";
  inputs.praetorium.url = "path:$role_flake";
  inputs.nixpkgs.follows = "praetorium/nixpkgs";
  outputs = { nixpkgs, praetorium, ... }: {
    nixosConfigurations.praetorium = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        praetorium.nixosModules.$module
        ./praetorium-role.nix
      ];
    };
  };
}
EOF
chmod 0644 "$flake"
echo "Pinning local role source and NixOS packages..."
nix --extra-experimental-features 'nix-command flakes' flake lock /etc/nixos
echo "Building pinned $role configuration; system remains unchanged until --apply..."
nix --extra-experimental-features 'nix-command flakes' build --no-link '/etc/nixos#nixosConfigurations.praetorium.config.system.build.toplevel'
echo "$role evaluation/build passed."
if [[ "$mode" == --apply ]]; then
  nixos-rebuild switch --flake '/etc/nixos#praetorium'
  echo "Applied $role NixOS configuration."
else
  echo "No system switch performed. Re-run with --apply after review."
fi
