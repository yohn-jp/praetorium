/** Ordered stages shared by the platform runner and its deployment regressions. */
export function platformDeploymentSteps(mode, notificationsEnabled) {
  if (mode === "--check") {
    return [
      { script: "deploy-k3s.mjs", mode: "--check", stage: "K3s resource/image preflight" },
      { script: "deploy-cloudflare.mjs", mode: "--preflight", stage: "Cloudflare resource/secret preflight" },
      { script: "deploy-cloudflare.mjs", mode: "--check", stage: "remote D1 migration readback" },
    ];
  }
  if (mode !== "--apply") throw new Error("platform mode must be --check or --apply");
  return [
    { script: "deploy-k3s.mjs", mode: "--check", stage: "K3s resource/image preflight" },
    { script: "deploy-cloudflare.mjs", mode: "--preflight", stage: "Cloudflare resource/secret preflight" },
    { script: "service-image-publication.mjs", mode: null, stage: "CI-published service image adoption and inventory admission" },
    { script: "deploy-cloudflare.mjs", mode: "--migrate", stage: "D1 migration apply and readback" },
    { script: "coordination", mode: "--apply", stage: "Management Coordination through the existing Ansible role" },
    { script: "observer", mode: "--apply", stage: "Management Observer through the existing Ansible role" },
    { script: "deploy-k3s.mjs", mode: "--apply", stage: "K3s workloads after verified D1 state" },
    ...(notificationsEnabled
      ? [{ script: "verify-work-notifications.mjs", mode: null, stage: "notification receiver readiness" }]
      : []),
    { script: "deploy-cloudflare.mjs", mode: "--workers", stage: "Workers after verified D1 and K3s state" },
  ];
}
