# Praetorium Admin Worker

Independent operator-only Cloudflare Worker for `admin.praetorium.yohn.jp`.

- UI and CSRF/origin checks live here. Desktop/Mobile compositions and existing release/Source diagnostics are migrated without introducing a second state machine.
- Gateway's named `AdminIdentityBroker` Service Binding owns GitHub OAuth sessions, one-time handoff redemption, and approved GitHub release source verification. No GitHub user OAuth tokens or Gateway DO encryption secrets are configured for this Worker.
- The canonical Control Plane owns operator Release/Build/Source states and audit. `ADMIN_CONTROL_PLANE_AUTH` must be provisioned as an **independent, role-scoped secret** on both this Worker and Control Plane. Never set it equal to `CONTROL_PLANE_GATEWAY_AUTH` or `RELEASE_OPERATOR_TOKEN`.
- Browser GET/POST requires a current Admin session via the private Gateway broker. Mutation forms require CSRF and Origin. `/healthz` and stylesheet are public but contain no operator state.
- Infrastructure data is a separate read-only VPC/Observer capability. Absence or outage must show unavailable, never healthy.
- Deploy the new Worker without attaching the live custom domain first. Migrate the admin custom domain from Gateway as a **single-owner** operation only after verifying OAuth handoff, source/build/release, negative security tests and rollback. Source changes here do not authorize production deployment.

Architecture and contract: [ADMINISTRATION.md](../../docs/architecture/ADMINISTRATION.md).
