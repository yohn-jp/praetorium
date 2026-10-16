{ config, lib, pkgs, ... }:

let
  cfg = config.praetorium.runtimeHost;
  noPlaceholder = value: builtins.typeOf value == "string" && !(lib.any (marker:
    lib.hasInfix marker (lib.toLower value)
  ) [ "<" ">" "{{" "}}" "replace" "changeme" "placeholder" "todo" ".example" ".invalid" ".localhost" ".test" ]);
  validCidr = cidr:
    builtins.match "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}/([1-9]|[12][0-9]|3[0-2])" cidr != null &&
    !(lib.any (reserved: lib.hasPrefix reserved cidr) [ "192.0.2." "198.51.100." "203.0.113." ]);
  safeManagementCidrs = builtins.filter validCidr cfg.managementCidrs;
  managementPorts = lib.optional cfg.ssh.enable cfg.ssh.port
    ++ lib.optional cfg.kubernetesApi.enable cfg.kubernetesApi.port;
  managementRules = lib.concatMapStringsSep "\n" (port:
    lib.concatMapStrings (cidr:
      "iptables -A nixos-fw -p tcp --dport ${toString port} -s ${cidr} -j nixos-fw-accept\n"
    ) safeManagementCidrs
  ) managementPorts;
in
{
  options.praetorium.runtimeHost = {
    enable = lib.mkEnableOption "Praetorium's K3s runtime host role";

    publicIngress = {
      enable = lib.mkOption { type = lib.types.bool; default = false; };
      allowHttpRedirect = lib.mkOption { type = lib.types.bool; default = false; };
    };

    managementCidrs = lib.mkOption {
      type = lib.types.listOf lib.types.nonEmptyStr;
      default = [ ];
      description = "Operator-owned source CIDRs allowed to reach SSH and the Kubernetes API.";
    };

    ssh = {
      enable = lib.mkOption { type = lib.types.bool; default = true; };
      port = lib.mkOption { type = lib.types.port; default = 22; };
      operatorUser = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Deployment-owned local operator account name.";
      };
      authorizedKeys = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
    };

    kubernetesApi = {
      enable = lib.mkOption { type = lib.types.bool; default = true; };
      port = lib.mkOption { type = lib.types.port; default = 6443; };
      tlsSans = lib.mkOption {
        type = lib.types.listOf lib.types.nonEmptyStr;
        default = [ ];
        description = "Private API SAN values supplied by the deployment inventory.";
      };
    };

    snapshotDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "External persistent K3s snapshot path; it must be outside the K3s state directory.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.managementCidrs != [ ] && lib.all validCidr cfg.managementCidrs;
        message = "praetorium.runtimeHost requires explicit private IPv4 management CIDRs";
      }
      {
        assertion = !cfg.ssh.enable || (cfg.ssh.operatorUser != null && cfg.ssh.authorizedKeys != [ ]);
        message = "praetorium.runtimeHost SSH requires an operator user and operator-provided public keys";
      }
      {
        assertion = !cfg.ssh.enable || (noPlaceholder cfg.ssh.operatorUser && lib.all noPlaceholder cfg.ssh.authorizedKeys);
        message = "praetorium.runtimeHost SSH values must not contain placeholders";
      }
      {
        assertion = lib.all noPlaceholder cfg.kubernetesApi.tlsSans;
        message = "praetorium.runtimeHost Kubernetes API SANs must not contain placeholders";
      }
      {
        assertion = cfg.snapshotDir == null ||
          (noPlaceholder cfg.snapshotDir && builtins.match "/[A-Za-z0-9._/-]+" cfg.snapshotDir != null && !(lib.hasInfix "/../" cfg.snapshotDir) &&
            cfg.snapshotDir != "/var/lib/rancher/k3s" &&
            !(lib.hasPrefix "/var/lib/rancher/k3s/" cfg.snapshotDir));
        message = "K3s snapshots must use a concrete external path outside its datastore directory";
      }
    ];

    networking.firewall = {
      enable = lib.mkForce true;
      allowPing = lib.mkForce false;
      allowedTCPPorts = lib.mkForce (
        if cfg.publicIngress.enable then
          [ 443 ] ++ lib.optional cfg.publicIngress.allowHttpRedirect 80
        else [ ]
      );
      allowedUDPPorts = lib.mkForce [ ];
      allowedTCPPortRanges = lib.mkForce [ ];
      allowedUDPPortRanges = lib.mkForce [ ];
      extraCommands = lib.mkAfter managementRules;
    };

    services.openssh = lib.mkIf cfg.ssh.enable {
      enable = true;
      openFirewall = false;
      ports = [ cfg.ssh.port ];
      settings = {
        AllowAgentForwarding = false;
        AllowTcpForwarding = "no";
        AuthenticationMethods = "publickey";
        KbdInteractiveAuthentication = false;
        PasswordAuthentication = false;
        PermitEmptyPasswords = false;
        PermitRootLogin = "no";
        PermitTunnel = false;
        PubkeyAuthentication = true;
        X11Forwarding = false;
        AllowUsers = lib.optional (cfg.ssh.operatorUser != null) cfg.ssh.operatorUser;
      };
    };

    users.users = lib.mkIf (cfg.ssh.enable && cfg.ssh.operatorUser != null) {
      ${cfg.ssh.operatorUser} = {
        isNormalUser = true;
        extraGroups = [ "wheel" ];
        openssh.authorizedKeys.keys = cfg.ssh.authorizedKeys;
      };
    };
    services.k3s = {
      enable = true;
      role = "server";
      disable = [ "traefik" ];
      extraFlags = [
        "--data-dir=/var/lib/rancher/k3s"
        "--write-kubeconfig-mode=0640"
      ] ++ lib.optional (cfg.kubernetesApi.tlsSans != [ ])
        "--tls-san=${lib.concatStringsSep "," cfg.kubernetesApi.tlsSans}"
        ++ lib.optional (cfg.snapshotDir != null)
          "--etcd-snapshot-dir=${cfg.snapshotDir}";
      clusterInit = true;
    };

  };
}
