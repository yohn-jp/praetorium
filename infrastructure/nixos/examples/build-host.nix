# Copy outside Git to /root/praetorium-build.nix, then supply real owned inputs.
# No XFS formatting or private key creation is performed by Praetorium.
{ ... }: {
  networking.hostName = "praetorium-build";
  services.qemuGuest.enable = true;
  praetorium.buildHost = {
    enable = true;
    clientCidrs = [ ]; # build worker egress source CIDRs
    egressCidrs = [ ]; # approved image sources/registry/proxy CIDRs
    egressProxyUrl = null; # HTTPS(S) proxy origin without embedded credentials
    storage.device = null; # stable /dev/disk/by-id entry for already formatted XFS device
    storage.quotaBytes = null;
    tls.serverCertFile = "/var/lib/praetorium/credentials/praetorium-buildkit-server.crt";
    tls.serverKeyFile = "/var/lib/praetorium/credentials/praetorium-buildkit-server.key";
    tls.clientCaFile = "/var/lib/praetorium/credentials/praetorium-buildkit-ca.crt";
    limits.cpuQuota = null;
    limits.memoryMax = null;
    limits.tasksMax = null;
  };
}
