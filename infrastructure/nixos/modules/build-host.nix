{ config, lib, pkgs, ... }:

let
  cfg = config.praetorium.buildHost;
  path = cfg.storage.mountpoint;
  cacheBytes = toString cfg.storage.quotaBytes;
  listenPort = toString cfg.listenPort;
  resourceFiles = [ cfg.tls.serverCertFile cfg.tls.serverKeyFile cfg.tls.clientCaFile ];
  noPlaceholder = value: builtins.typeOf value == "string" && !(lib.any (marker:
    lib.hasInfix marker (lib.toLower value)
  ) [ "<" ">" "{{" "}}" "replace" "changeme" "placeholder" "todo" ".example" ".invalid" ".localhost" ".test" ]);
  validProxy = cfg.egressProxyUrl != null &&
    builtins.match "https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?" cfg.egressProxyUrl != null &&
    noPlaceholder cfg.egressProxyUrl;
  validCidr = cidr:
    builtins.match "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}/([1-9]|[12][0-9]|3[0-2])" cidr != null &&
    !(lib.any (reserved: lib.hasPrefix reserved cidr) [ "192.0.2." "198.51.100." "203.0.113." ]);
  safeClientCidrs = builtins.filter validCidr cfg.clientCidrs;
  inputsReady =
    cfg.storage.device != null && noPlaceholder cfg.storage.device &&
    cfg.storage.quotaBytes != null &&
    lib.all (file: file != null && builtins.match "/(run/secrets|var/lib/praetorium/credentials)/[A-Za-z0-9._/-]+" file != null && !(lib.hasInfix "/../" file) && noPlaceholder file) resourceFiles &&
    cfg.limits.cpuQuota != null &&
    cfg.limits.memoryMax != null &&
    cfg.limits.tasksMax != null &&
    validProxy &&
    cfg.clientCidrs != [ ] &&
    lib.all validCidr cfg.clientCidrs &&
    cfg.egressCidrs != [ ] &&
    lib.all validCidr cfg.egressCidrs;
  firewallRules = lib.concatMapStringsSep "\n" (cidr:
    "iptables -A nixos-fw -p tcp --dport ${listenPort} -s ${cidr} -j nixos-fw-accept\n"
  ) safeClientCidrs;
in
{
  options.praetorium.buildHost = {
    enable = lib.mkEnableOption "Praetorium's isolated BuildKit host role";

    listenPort = lib.mkOption {
      type = lib.types.port;
      default = 1234;
      description = "mTLS BuildKit endpoint port. Only inventory-listed worker CIDRs are admitted.";
    };

    clientCidrs = lib.mkOption {
      type = lib.types.listOf lib.types.nonEmptyStr;
      default = [ ];
      description = "Exact worker source ranges allowed to use the BuildKit endpoint.";
    };

    egressCidrs = lib.mkOption {
      type = lib.types.listOf lib.types.nonEmptyStr;
      default = [ ];
      description = "Explicit BuildKit resolver and approved build-input/registry egress CIDRs.";
    };

    egressProxyUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Operator-owned egress proxy URL used with BuildKit proxy networking.";
    };

    tls = {
      serverCertFile = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };
      serverKeyFile = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };
      clientCaFile = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };
    };

    storage = {
      device = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Operator-provisioned XFS filesystem device; never format it from this module.";
      };
      mountpoint = lib.mkOption {
        type = lib.types.str;
        default = "/var/lib/praetorium-buildkit";
      };
      quotaBytes = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        description = "Hard XFS project quota for all BuildKit cache and snapshot state.";
      };
    };

    limits = {
      cpuQuota = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };
      memoryMax = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };
      tasksMax = lib.mkOption { type = lib.types.nullOr lib.types.ints.positive; default = null; };
    };

  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.clientCidrs != [ ];
        message = "praetorium.buildHost requires explicit Build Worker client CIDRs";
      }
      {
        assertion = cfg.egressCidrs != [ ];
        message = "praetorium.buildHost requires an explicit build-input egress allowlist";
      }
      {
        assertion = validProxy && !(lib.hasInfix "@" cfg.egressProxyUrl);
        message = "praetorium.buildHost requires a credential-free HTTP(S) egress proxy origin";
      }
      {
        assertion = lib.all validCidr (cfg.clientCidrs ++ cfg.egressCidrs);
        message = "BuildKit client and egress allowlists must contain safe IPv4 CIDRs";
      }
      {
        assertion = cfg.storage.device != null && noPlaceholder cfg.storage.device && cfg.storage.quotaBytes != null;
        message = "praetorium.buildHost requires an operator-provisioned XFS device and hard quota";
      }
      {
        assertion = path == "/var/lib/praetorium-buildkit";
        message = "BuildKit state must use its dedicated filesystem mountpoint";
      }
      {
        assertion = lib.all (file: file != null && builtins.match "/(run/secrets|var/lib/praetorium/credentials)/[A-Za-z0-9._/-]+" file != null && !(lib.hasInfix "/../" file) && noPlaceholder file) resourceFiles;
        message = "BuildKit server certificate, private key and client CA must be protected /run/secrets or /var/lib/praetorium/credentials references";
      }
      {
        assertion = cfg.limits.cpuQuota != null && cfg.limits.memoryMax != null && cfg.limits.tasksMax != null;
        message = "praetorium.buildHost requires fixed CPU, memory, and task limits";
      }
      {
        assertion = !config.services.k3s.enable;
        message = "BuildKit must run on a separate host without K3s runtime privileges";
      }
      {
        assertion = !config.virtualisation.docker.enable;
        message = "BuildKit host must not expose the privileged Docker socket";
      }
    ];

    users.groups.buildkit = { };
    users.users.buildkit = {
      isSystemUser = true;
      group = "buildkit";
      home = path;
      createHome = true;
      autoSubUidGidRange = true;
    };

    fileSystems.${path} = lib.mkIf (cfg.storage.device != null) {
      device = cfg.storage.device;
      fsType = "xfs";
      options = [ "prjquota" "noatime" ];
    };

    environment.etc."projects".text = "1001:${path}\n";
    environment.etc."projid".text = "praetorium-buildkit:1001\n";
    environment.etc."buildkit/buildkitd.toml".text = lib.mkIf inputsReady ''
      root = "${path}/state"
      proxyNetwork = true

      [grpc]
        address = [ "tcp://0.0.0.0:${listenPort}" ]
        [grpc.tls]
          cert = "/run/credentials/praetorium-buildkit.service/server.crt"
          key = "/run/credentials/praetorium-buildkit.service/server.key"
          ca = "/run/credentials/praetorium-buildkit.service/client-ca.crt"

      [worker.oci]
        rootless = true
        max-parallelism = 1
        gc = true
        maxUsedSpace = ${cacheBytes}
        reservedSpace = "5%"
    '';

    networking.firewall = {
      enable = lib.mkForce true;
      allowedTCPPorts = lib.mkForce [ ];
      allowedUDPPorts = lib.mkForce [ ];
      allowedTCPPortRanges = lib.mkForce [ ];
      allowedUDPPortRanges = lib.mkForce [ ];
      extraCommands = lib.mkAfter firewallRules;
    };

    systemd.services.praetorium-buildkit-prepare = lib.mkIf inputsReady {
      description = "Prepare quota and owned state for Praetorium BuildKit";
      wantedBy = [ "multi-user.target" ];
      requires = [ "var-lib-praetorium\\x2dbuildkit.mount" ];
      after = [ "var-lib-praetorium\\x2dbuildkit.mount" ];
      before = [ "praetorium-buildkit.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = pkgs.writeShellScript "praetorium-buildkit-prepare" ''
          set -eu
          ${pkgs.xfsprogs}/bin/xfs_quota -x -c 'project -s praetorium-buildkit' -c 'limit -p bhard=${cacheBytes} praetorium-buildkit' ${path}
          ${pkgs.coreutils}/bin/mkdir -p ${path}/state
          ${pkgs.coreutils}/bin/chown buildkit:buildkit ${path} ${path}/state
        '';
      };
    };

    systemd.services.praetorium-buildkit = lib.mkIf inputsReady {
      description = "Praetorium rootless mTLS BuildKit daemon";
      wantedBy = [ "multi-user.target" ];
      requires = [ "praetorium-buildkit-prepare.service" ];
      after = [ "network-online.target" "praetorium-buildkit-prepare.service" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        User = "buildkit";
        Group = "buildkit";
        RuntimeDirectory = "praetorium-buildkit";
        RuntimeDirectoryMode = "0700";
        WorkingDirectory = path;
        LoadCredential = [
          "server.crt:${cfg.tls.serverCertFile}"
          "server.key:${cfg.tls.serverKeyFile}"
          "client-ca.crt:${cfg.tls.clientCaFile}"
        ];
        ExecStart = ''
          ${pkgs.rootlesskit}/bin/rootlesskit \
            --net=slirp4netns \
            --slirp4netns-binary=${pkgs.slirp4netns}/bin/slirp4netns \
            --disable-host-loopback \
            --port-driver=builtin \
            --publish-port=0.0.0.0:${listenPort}:${listenPort}/tcp \
            ${pkgs.buildkit}/bin/buildkitd --config /etc/buildkit/buildkitd.toml --rootless
        '';
        Restart = "on-failure";
        RestartSec = "5s";
        Environment = [
          "XDG_RUNTIME_DIR=/run/praetorium-buildkit"
          "HTTP_PROXY=${cfg.egressProxyUrl}"
          "HTTPS_PROXY=${cfg.egressProxyUrl}"
        ];
        CPUQuota = cfg.limits.cpuQuota;
        MemoryMax = cfg.limits.memoryMax;
        TasksMax = cfg.limits.tasksMax;
        # RootlessKit needs setuid newuidmap/newgidmap to establish the
        # configured subordinate UID/GID ranges. Keep the capability set
        # limited to those mapping operations.
        CapabilityBoundingSet = [ "CAP_SETUID" "CAP_SETGID" ];
        # slirp4netns needs its isolated TAP device; the cgroup device filter
        # exposes only that device rather than the host's full /dev tree.
        PrivateDevices = false;
        DevicePolicy = "closed";
        DeviceAllow = [ "/dev/net/tun rw" ];
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ path "/run/praetorium-buildkit" ];
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
        IPAddressAllow = cfg.clientCidrs ++ cfg.egressCidrs ++ [ "127.0.0.0/8" "::1/128" ];
        IPAddressDeny = "any";
        UMask = "0077";
      };
    };

  };
}
