# Praetorium host bootstrap

`playbooks/host-bootstrap.yml` configures the existing Management Ubuntu host's common prerequisites and optional Coordination service. It does not initialize K3s, modify DNS or Cloudflare routes, touch tenant manifests, or remove host data.

The separate K3s plays are deliberately gated. `playbooks/management-server.yml` stages the pinned K3s Server binary, exact steady-state configuration allowlist, and fixed systemd unit only when `praetorium_management_server_prepare: true`; restore-only K3s options are rejected and unit drop-ins are not accepted. It will not start the Server unless `praetorium_management_server_start: true` and the same-cluster restore, current Secret/resource state, full workspace copy, Writer absence, and old-Server retirement evidence all pass. Startup also requires an existing restored embedded-etcd member database and token parent on Management; the role never creates an empty cluster.

`playbooks/runtime-agent.yml` requires `runtime_agent_apply: true`, the same completed restore evidence, active Management Server evidence, a reachable private API endpoint, and an already stopped and disabled Runtime `k3s.service`. It accepts only the exact Agent config and service templates and rejects unit drop-ins. It writes only a separate Agent config, token, data directory, marker, and `k3s-agent.service`; it never stops or uninstalls the old Server or removes its data. The migration must retire the Server through the reviewed datastore-specific procedure first.

`playbooks/builder-audit.yml` is read-only. It checks the existing rootless BuildKit unit and effective systemd properties, reads the service cgroup's `cpu.max`, `memory.max`, and `pids.max`, and verifies cache ownership, GC configuration, service health, and absence of K3s membership. It does not alter the BuildKit cache, unit, configuration, or resource limits.

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

## Fresh replacement cluster bootstrap

`playbooks/fresh-cluster-bootstrap.yml` is a one-time path for starting a new single-server embedded-etcd cluster on Management and joining Runtime as an Agent. It is separate from the restore roles: it performs no datastore or workload restore and does not preserve the previous cluster's Kubernetes resources or persistent-volume data. It reads the existing `clusterId` from the supplied production inventory, starts the new server with `cluster-init`, and transfers its generated node token with task logging disabled. Management K3s state must be absent; Runtime's old Server must already be inactive and disabled. After Runtime is Ready, the playbook removes the obsolete Server unit and uninstall helper without restarting the Agent.

Run it only with the operator's private host inventory, product inventory JSON, Management API address, and staged pinned K3s binary:

```sh
ansible-playbook -i /path/to/private/hosts.json playbooks/fresh-cluster-bootstrap.yml \
  -e @/path/to/production/inventory.json \
  -e praetorium_fresh_k3s_confirm=true \
  -e praetorium_fresh_management_api_host=192.0.2.33 \
  -e praetorium_fresh_k3s_binary_src=/path/to/pinned/k3s
```
