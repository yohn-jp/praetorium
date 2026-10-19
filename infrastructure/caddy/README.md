# Public TLS ingress — owner-operated Caddy

**2026-10-20 decision:** Public DNS `*.scriptorium.yohn.jp` is a single
DNS-only CNAME to `gateway.yohn.jp`. The certificate for this hostname is
issued and renewed **inside Praetorium k3s** by cert-manager DNS-01. Traefik
terminates client TLS and routes the unchanged original HTTP Host.

The previous `application-origins.Caddyfile` example terminated TLS in
Caddy and then started a new TLS connection to Traefik. It is no longer
compatible with the owner's TLS-termination decision and has been removed.

The owner configures Caddy separately. For Scriptorium public HTTPS,
Caddy must pass through raw TCP/TLS on the ClientHello SNI for
`*.scriptorium.yohn.jp` to the k3s Traefik `websecure` listener; it
must not decrypt, issue a certificate, rewrite Host, or strip SNI.
Normal Caddy HTTP `reverse_proxy` does **not** provide passthrough;
a verified layer4-capable implementation or equivalent TCP proxy is required.
Coexistence with other Caddy HTTPS hosts requires inspecting the live 443
listener, module capabilities and ordering first.

Neither this README nor the Kubernetes manifests configure the
owner-managed Caddy. Public TLS is **NOT_CHECKED** until the TCP passthrough
and actual k3s Certificate are verified.
