import { isIP } from "node:net";

function addressKey(address) {
  return isIP(address) === 6 ? new URL(`https://[${address}]`).hostname.slice(1, -1) : address;
}

function safeEndpoint(address) {
  if (typeof address !== "string" || address.includes("%") || !isIP(address)) return false;
  const key = addressKey(address);
  if (isIP(key) === 6) {
    return !/^(?:ff|fe[89ab]|::)/i.test(key) && key !== "fd00:ec2::254" && key !== "fd20:ce::254";
  }
  const [first, second] = key.split(".").map(Number);
  return (
    first !== 0 &&
    first !== 127 &&
    first < 224 &&
    !(first === 169 && second === 254) &&
    key !== "168.63.129.16" &&
    key !== "100.100.100.200"
  );
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",")
  );
}

function hostCidr(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    safeEndpoint(parts[0]) &&
    parts[1] === (isIP(parts[0]) === 4 ? "32" : "128")
  );
}

function needsExplicitEndpoint(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) return true;
  if (isIP(host) === 6) return /^(?:f[cd]|fe[89abcdef]|::)/i.test(addressKey(host));
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      !safeEndpoint(host)
    );
  }
  return !host.includes(".") || /\.(?:localhost|local|internal|test|invalid)$/i.test(host);
}

export function validateSystemNetwork(network, domains) {
  const errors = [];
  const blockers = [];
  if (!exactKeys(network, ["kubernetesApiEndpoints", "controlPlaneCidrs", "gatewayServiceCidrs"])) {
    return {
      errors: [
        "network must contain exactly kubernetesApiEndpoints, controlPlaneCidrs, gatewayServiceCidrs",
      ],
      blockers,
    };
  }
  const endpoints = network.kubernetesApiEndpoints;
  if (endpoints === null || (Array.isArray(endpoints) && endpoints.length === 0)) {
    blockers.push(
      "network.kubernetesApiEndpoints has not been supplied (service VIP and CNI post-DNAT destinations)",
    );
  } else if (
    !Array.isArray(endpoints) ||
    endpoints.length > 16 ||
    endpoints.some(
      (endpoint) =>
        !exactKeys(endpoint, ["address", "port"]) ||
        !safeEndpoint(endpoint.address) ||
        !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 ||
        endpoint.port > 65535,
    )
  ) {
    errors.push(
      "network.kubernetesApiEndpoints must contain at most 16 explicit unicast IP addresses and TCP ports 1..65535",
    );
  } else if (
    new Set(endpoints.map((endpoint) => `${addressKey(endpoint.address)}:${endpoint.port}`))
      .size !== endpoints.length
  ) {
    errors.push("network.kubernetesApiEndpoints must not contain duplicates");
  }
  for (const [field, originField] of [
    ["controlPlaneCidrs", "controlPlaneUrl"],
    ["gatewayServiceCidrs", "gatewayServiceUrl"],
  ]) {
    const cidrs = network[field];
    if (!Array.isArray(cidrs) || cidrs.length > 32 || cidrs.some((cidr) => !hostCidr(cidr))) {
      errors.push(
        `network.${field} must contain at most 32 explicit unicast host CIDRs (/32 or /128)`,
      );
      continue;
    }
    const normalized = cidrs.map((cidr) => addressKey(cidr.split("/")[0]));
    if (new Set(normalized).size !== normalized.length)
      errors.push(`network.${field} must not contain duplicates`);
    if (typeof domains?.[originField] !== "string") continue;
    try {
      const url = new URL(domains[originField]);
      if (needsExplicitEndpoint(url) && cidrs.length === 0)
        blockers.push(
          `network.${field} is required for the private or non-standard domains.${originField}`,
        );
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && cidrs.length && !normalized.includes(addressKey(host)))
        errors.push(`network.${field} must include the literal domains.${originField} address`);
    } catch {
      /* URL validation belongs to the shared inventory validator. */
    }
  }
  return { errors, blockers };
}

function egressRules(endpoints) {
  return endpoints
    .map(({ address, port }) =>
      [
        "    - to:",
        "        - ipBlock:",
        `            cidr: ${JSON.stringify(`${address}/${isIP(address) === 4 ? 32 : 128}`)}`,
        "      ports:",
        "        - protocol: TCP",
        `          port: ${port}`,
      ].join("\n"),
    )
    .join("\n");
}

export function systemNetworkRenderValues(inventory) {
  const result = validateSystemNetwork(inventory.network, inventory.domains);
  if (result.errors.length || result.blockers.length)
    throw new Error([...result.errors, ...result.blockers].join("; "));
  const originEndpoints = (cidrs, origin) =>
    cidrs.map((cidr) => ({
      address: cidr.split("/")[0],
      port: Number(new URL(origin).port || (new URL(origin).protocol === "https:" ? 443 : 80)),
    }));
  return {
    "    # @@PROVISIONER_API_EGRESS_RULES@@": egressRules(inventory.network.kubernetesApiEndpoints),
    "    # @@PROVISIONER_PRIVATE_CONTROL_PLANE_EGRESS_RULES@@": egressRules(
      originEndpoints(inventory.network.controlPlaneCidrs, inventory.domains.controlPlaneUrl),
    ),
    "    # @@INSTANCE_ACCESS_PRIVATE_GATEWAY_EGRESS_RULES@@": egressRules(
      originEndpoints(inventory.network.gatewayServiceCidrs, inventory.domains.gatewayServiceUrl),
    ),
  };
}
