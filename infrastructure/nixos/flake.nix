{
  description = "Praetorium NixOS host-role modules";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs, ... }: {
    nixosModules = {
      runtimeHost = import ./modules/runtime-host.nix;
      buildHost = import ./modules/build-host.nix;
    };

    checks.x86_64-linux.module-syntax =
      let pkgs = nixpkgs.legacyPackages.x86_64-linux;
      in pkgs.runCommand "praetorium-nixos-module-syntax" { nativeBuildInputs = [ pkgs.nix ]; } ''
        nix-instantiate --parse ${./modules/runtime-host.nix} >/dev/null
        nix-instantiate --parse ${./modules/build-host.nix} >/dev/null
        touch "$out"
      '';
  };
}
