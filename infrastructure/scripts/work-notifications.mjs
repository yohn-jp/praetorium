export function workNotificationsEnabled(inventory) {
  return inventory.workNotifications?.enabled === true;
}

export function workNotificationEndpoints(inventory) {
  if (!workNotificationsEnabled(inventory)) return null;
  const suffix = inventory.domains.instanceHostnameSuffix;
  return {
    provisioner: `https://notify-provisioner.${suffix}/internal/work-available`,
    build: `https://notify-build.${suffix}/internal/work-available`,
  };
}

export function validateWorkNotificationTokens({
  provisioner,
  build,
  provisionerClaim,
  buildClaim,
}) {
  const values = {
    provisioner: Buffer.from(provisioner),
    build: Buffer.from(build),
    provisionerClaim: Buffer.from(provisionerClaim),
    buildClaim: Buffer.from(buildClaim),
  };
  for (const role of ["provisioner", "build"]) {
    const value = values[role];
    if (
      value.length < 32 ||
      value.length > 512 ||
      value.some((byte) => byte < 0x21 || byte > 0x7e)
    ) {
      throw new Error(`${role} work notification token must be 32-512 printable ASCII characters`);
    }
  }
  for (const notification of ["provisioner", "build"]) {
    for (const credential of ["provisionerClaim", "buildClaim"]) {
      if (values[notification].equals(values[credential])) {
        throw new Error(`${notification} work notification token must be distinct from claim credentials`);
      }
    }
  }
  if (values.provisioner.equals(values.build)) {
    throw new Error("provisioner and build work notification tokens must be distinct");
  }
}

export async function verifyWorkNotificationEndpoints(
  endpoints,
  tokens,
  fetcher = fetch,
) {
  for (const [kind, key] of [
    ["operation", "provisioner"],
    ["build", "build"],
  ]) {
    let response;
    try {
      response = await fetcher(endpoints[key], {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens[key]}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, kind }),
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error(`${key} work notification endpoint could not be reached over HTTPS`);
    }
    await response.body?.cancel();
    if (response.status !== 202) {
      throw new Error(`${key} work notification endpoint returned HTTP ${response.status}, expected 202`);
    }
  }
}
