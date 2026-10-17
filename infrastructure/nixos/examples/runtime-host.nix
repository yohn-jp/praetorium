# Copy outside Git to /root/praetorium-runtime.nix, then fill the required values.
# Deliberately incomplete: evaluation must fail until private management access is set.
{ ... }: {
  networking.hostName = "praetorium-runtime";
  services.qemuGuest.enable = true;
  praetorium.runtimeHost = {
    enable = true;
    clusterId = null; # match inventory.clusterId; e.g. clu_<26 Crockford chars>
    managementCidrs = [ ]; # VPN administrator and internal cluster management networks
    ssh.operatorUser = "operator";
    ssh.authorizedKeys = [ ]; # public keys, never private keys
    publicIngress.enable = false; # route via an approved private tunnel
    kubernetesApi.tlsSans = [ ];
  };
}
