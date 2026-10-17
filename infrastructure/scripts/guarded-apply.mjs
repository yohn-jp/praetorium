import {
  assertAdmissionApi,
  selectAdmissionGuards,
  waitForAdmissionGuards,
} from "./admission-readiness.mjs";

// The caller supplies one canonical render and explicit owned-cluster clients.
// Never expose bootstrap RBAC from the full bundle before guard readiness.
export async function applyGuardedBundle({
  bundle,
  discover,
  serverDryRun,
  apply,
  readPolicy,
  readBinding,
}) {
  const guards = selectAdmissionGuards(bundle);
  assertAdmissionApi(await discover());
  await serverDryRun(bundle);
  await apply(guards);
  await waitForAdmissionGuards({ readPolicy, readBinding });
  await apply(bundle);
}
