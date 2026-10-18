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

function parseJson(bytes, label, { fatalUtf8 = true } = {}) {
  try {
    return JSON.parse(
      fatalUtf8 ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes.toString("utf8"),
    );
  } catch {
    throw new Error(`${label} registry credential is invalid`);
  }
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function credentialTokens(username, password) {
  const pair = `${username}:${password}`;
  return [
    Buffer.from(username, "utf8"),
    Buffer.from(password, "utf8"),
    Buffer.from(pair, "utf8"),
    Buffer.from(pair, "utf8").toString("base64"),
  ].map((value) => Buffer.from(value));
}

function registryAuthHost(value) {
  if (value === "https://index.docker.io/v1/") return "docker.io";
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    ) {
      return null;
    }
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function registryCredentialMaterials({ registryPull, registryPush, registryHost }) {
  const pullBytes = Buffer.from(registryPull);
  const pushBytes = Buffer.from(registryPush);
  if (pullBytes.length < 2 || pullBytes.length > 4_096 || pushBytes.length > 65_536) {
    throw new Error("registry credential files are invalid");
  }

  const pull = parseJson(pullBytes, "pull");
  if (
    !pull ||
    typeof pull !== "object" ||
    Array.isArray(pull) ||
    Object.keys(pull).length !== 2 ||
    Object.keys(pull).some((key) => key !== "username" && key !== "password") ||
    typeof pull.username !== "string" ||
    typeof pull.password !== "string" ||
    pull.username.length < 1 ||
    pull.username.length > 256 ||
    pull.password.length < 1 ||
    pull.password.length > 2_048 ||
    hasControlCharacters(pull.username) ||
    hasControlCharacters(pull.password)
  ) {
    throw new Error("pull registry credential is invalid");
  }

  const push = parseJson(pushBytes, "push", { fatalUtf8: false });
  if (
    !push ||
    typeof push !== "object" ||
    Array.isArray(push) ||
    Object.keys(push).some((key) => key !== "auths") ||
    typeof push.auths !== "object" ||
    push.auths === null ||
    Array.isArray(push.auths)
  ) {
    throw new Error("push registry credential is invalid");
  }
  const entry = Object.entries(push.auths).find(
    ([server]) => registryAuthHost(server) === registryHost,
  )?.[1];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("push registry credential is invalid");
  }

  const username = typeof entry.username === "string" ? entry.username : "";
  const password = typeof entry.password === "string" ? entry.password : "";
  let resolvedUsername = username;
  let resolvedPassword = password;
  if ((!resolvedUsername || !resolvedPassword) && typeof entry.auth === "string") {
    const encoded = entry.auth;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new Error("push registry credential is invalid");
    }
    const decodedBytes = Buffer.from(encoded, "base64");
    if (decodedBytes.toString("base64") !== encoded) {
      throw new Error("push registry credential is invalid");
    }
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes);
    } catch {
      throw new Error("push registry credential is invalid");
    }
    const separator = decoded.indexOf(":");
    if (separator > 0) {
      resolvedUsername = decoded.slice(0, separator);
      resolvedPassword = decoded.slice(separator + 1);
    }
  }
  if (
    resolvedUsername.length < 1 ||
    resolvedUsername.length > 256 ||
    resolvedPassword.length < 1 ||
    resolvedPassword.length > 4_096 ||
    hasControlCharacters(resolvedUsername) ||
    hasControlCharacters(resolvedPassword)
  ) {
    throw new Error("push registry credential is invalid");
  }

  const pushTokens = credentialTokens(resolvedUsername, resolvedPassword);
  for (const field of ["auth", "identitytoken"]) {
    if (typeof entry[field] === "string" && entry[field] !== "") {
      pushTokens.push(Buffer.from(entry[field], "utf8"));
    }
  }
  return [
    pullBytes,
    ...credentialTokens(pull.username, pull.password),
    pushBytes,
    ...pushTokens,
  ];
}

export function validateWorkNotificationTokens({
  provisioner,
  build,
  provisionerClaim,
  buildClaim,
  registryPull,
  registryPush,
  registryHost,
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
  const registryMaterials = registryCredentialMaterials({ registryPull, registryPush, registryHost });
  for (const notification of ["provisioner", "build"]) {
    if (registryMaterials.some((material) => values[notification].equals(material))) {
      throw new Error(`${notification} work notification token must be distinct from registry credentials`);
    }
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
