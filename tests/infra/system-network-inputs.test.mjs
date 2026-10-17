import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  validateSystemNetwork,
  systemNetworkRenderValues,
} from "../../infrastructure/scripts/system-network.mjs";
import { validateInventory } from "../../infrastructure/scripts/inventory.mjs";

function fixture() {
  return {
    network: {
      kubernetesApiEndpoints: [
        { address: "10.96.0.1", port: 443 },
        { address: "10.0.1.2", port: 6443 },
      ],
      controlPlaneCidrs: ["10.0.1.3/32"],
      gatewayServiceCidrs: ["fd00::4/128"],
    },
    domains: {
      controlPlaneUrl: "https://control-plane.internal:8443",
      gatewayServiceUrl: "http://gateway.internal:8080",
    },
  };
}

test("API destinations stay unset until explicitly supplied; inventory has no guessed network", async () => {
  const inventory = JSON.parse(
    await readFile(new URL("../../infrastructure/test/disposable-inventory.json", import.meta.url)),
  );
  assert.deepEqual(inventory.network, {
    kubernetesApiEndpoints: null,
    controlPlaneCidrs: [],
    gatewayServiceCidrs: [],
  });
  const result = validateInventory(inventory);
  assert.deepEqual(result.errors, []);
  assert.ok(result.blockers.some((item) => item.startsWith("network.kubernetesApiEndpoints")));
  assert.throws(() => systemNetworkRenderValues(inventory), /kubernetesApiEndpoints/);
});

test("explicit API and private origins render only host destinations at the actual ports", () => {
  const input = fixture();
  assert.deepEqual(validateSystemNetwork(input.network, input.domains), {
    errors: [],
    blockers: [],
  });
  const values = systemNetworkRenderValues(input);
  const api = values["    # @@PROVISIONER_API_EGRESS_RULES@@"];
  assert.match(api, /cidr: "10\.96\.0\.1\/32"/);
  assert.match(api, /cidr: "10\.0\.1\.2\/32"/);
  assert.match(api, /port: 6443/);
  assert.match(values["    # @@PROVISIONER_PRIVATE_CONTROL_PLANE_EGRESS_RULES@@"], /port: 8443/);
  assert.match(
    values["    # @@INSTANCE_ACCESS_PRIVATE_GATEWAY_EGRESS_RULES@@"],
    /cidr: "fd00::4\/128"[\s\S]*port: 8080/,
  );
});

test("private/nonstandard origins require explicit destinations; public default HTTPS stays bounded by public rule", () => {
  const input = fixture();
  input.network.controlPlaneCidrs = [];
  input.network.gatewayServiceCidrs = [];
  assert.equal(validateSystemNetwork(input.network, input.domains).blockers.length, 2);
  input.domains = {
    controlPlaneUrl: "https://cp.owned-domain.org",
    gatewayServiceUrl: "https://gateway.owned-domain.org",
  };
  assert.deepEqual(validateSystemNetwork(input.network, input.domains), {
    errors: [],
    blockers: [],
  });
  assert.equal(
    systemNetworkRenderValues(input)["    # @@INSTANCE_ACCESS_PRIVATE_GATEWAY_EGRESS_RULES@@"],
    "",
  );
});

test("additive rules cannot reopen metadata, local host, multicast or broad networks", () => {
  for (const address of [
    "0.0.0.0",
    "127.0.0.1",
    "169.254.169.254",
    "168.63.129.16",
    "100.100.100.200",
    "224.0.0.1",
    "::",
    "::1",
    "fe80::1",
    "ff02::1",
    "::ffff:169.254.169.254",
    "::169.254.169.254",
    "0:0:0:0:0:0:a9fe:a9fe",
    "fe80::1%lo",
    "fd00:ec2::254",
    "fd00:0ec2:0:0:0:0:0:0254",
    "fd20:ce::254",
    null,
    123,
  ]) {
    const input = fixture();
    input.network.kubernetesApiEndpoints = [{ address, port: 443 }];
    assert.ok(validateSystemNetwork(input.network, input.domains).errors.length, String(address));
    assert.throws(() => systemNetworkRenderValues(input));
  }
  for (const cidr of [
    "0.0.0.0/0",
    "10.0.0.0/8",
    "169.254.169.254/32",
    "168.63.129.16/32",
    "100.100.100.200/32",
    "::169.254.169.254/128",
    "fd00:ec2::254/128",
    "fd20:ce::254/128",
    "fe80::1/128",
    "::/0",
    "10.0.1.3/32\n  - bad:",
  ]) {
    const input = fixture();
    input.network.controlPlaneCidrs = [cidr];
    assert.ok(validateSystemNetwork(input.network, input.domains).errors.length, cidr);
  }
});

test("duplicate endpoints, unsafe ports, unknown keys and mismatched literal origin fail validation", () => {
  for (const port of [0, 65536, 1.5, "443"]) {
    const input = fixture();
    input.network.kubernetesApiEndpoints[0].port = port;
    assert.ok(validateSystemNetwork(input.network, input.domains).errors.length);
  }
  const input = fixture();
  input.network.kubernetesApiEndpoints.push({ ...input.network.kubernetesApiEndpoints[0] });
  assert.match(validateSystemNetwork(input.network, input.domains).errors.join(";"), /duplicates/);
  input.network = fixture().network;
  input.network.allowAll = true;
  assert.ok(validateSystemNetwork(input.network, input.domains).errors.length);
  delete input.network.allowAll;
  input.domains.controlPlaneUrl = "https://10.0.1.9";
  assert.match(validateSystemNetwork(input.network, input.domains).errors.join(";"), /literal/);
});

test("deprecated IPv6 site-local origins require explicit host destinations", () => {
  const input = fixture();
  input.domains.controlPlaneUrl = "https://[fec0::1]";
  input.network.controlPlaneCidrs = [];
  assert.ok(
    validateSystemNetwork(input.network, input.domains).blockers.some((item) =>
      item.includes("controlPlaneCidrs"),
    ),
  );
  input.network.controlPlaneCidrs = ["fec0::1/128"];
  assert.deepEqual(validateSystemNetwork(input.network, input.domains), {
    errors: [],
    blockers: [],
  });
});
