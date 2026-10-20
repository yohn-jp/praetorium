# Praetorium host bootstrap

`playbooks/host-bootstrap.yml` configures the existing Management Ubuntu host's common prerequisites and optional Coordination service. It does not initialize K3s, modify DNS or Cloudflare routes, touch tenant manifests, or remove host data.

Copy `inventories/example/` into an operator-controlled inventory. Keep SSH keys, notification credentials, and the Cloudflare Tunnel token outside Git. Coordination is disabled by default; enabling it requires an immutable `repository@sha256:...` image reference, exact package-version pins, the two existing notification token source files, and the private Runtime notification host mappings. The role preserves the HTTPS notification hostnames and resolves them to the private Runtime address inside the rootless container.

When the dedicated remotely managed Cloudflare Tunnel is enabled, its protected local token source must be a regular mode `0600` file. The role installs it at `/var/lib/praetorium/credentials/coordination-tunnel.token`, owned by the `cloudflared` system account, and starts a separate host systemd service. It creates no DNS records and does not alter the remote Tunnel or VPC Service configuration.

Run checks with the operator inventory before applying:

```sh
ansible-playbook -i /path/to/operator/inventory.yml playbooks/host-bootstrap.yml --syntax-check
ansible-playbook -i /path/to/operator/inventory.yml playbooks/host-bootstrap.yml --check --diff
```

On a fresh Management host, discover the current package candidates before filling the exact version pins. The source task enables Ubuntu Universe and, when the tunnel is opted in, configures Cloudflare's official signed package source. Then the read-only discovery task prints the package policy without installing packages:

```sh
ansible-playbook -i /path/to/operator/inventory.yml playbooks/host-bootstrap.yml --tags coordination-package-sources
ansible-playbook -i /path/to/operator/inventory.yml playbooks/host-bootstrap.yml --tags coordination-package-discovery
```

The example inventory is intentionally non-deployable. Syntax checks and check mode do not validate the hosted Coordination path, tunnel connectivity, or notification delivery.
