# Example ONLY: adapt management CIDRs, SSH identity and storage before use.
# Save outside the repository as /root/praetorium-runtime-host.nix.
{ ... }: {
  networking.hostName = "praetorium-runtime";
  praetorium.runtimeHost = {
    enable = true;
    managementCidrs = [ "10.0.0.0/24" ];
    ssh.operatorUser = "operator";
    ssh.authorizedKeys = [ "ssh-ed25519 REPLACE_WITH_YOUR_PUBLIC_KEY" ];
    publicIngress.enable = false;
  };
}
