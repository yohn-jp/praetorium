import { describe, expect, it, vi } from "vitest";
import { Observer, parseObserverConfig } from "../src/collector.js";

const token = "observer-test-token-" + "z".repeat(48);
const inventory = JSON.stringify([
  {id:"management",role:"management",metricsUrl:"http://10.7.0.33:9100/metrics",
    services:[{id:"coordination",url:"http://10.7.0.33:8790/healthz"}]},
  {id:"runtime",role:"runtime",metricsUrl:"http://10.7.0.31:9100/metrics",
    services:[]},
  {id:"builder",role:"builder",metricsUrl:"http://10.7.0.32:9100/metrics",
    services:[]},
]);
const sample = (total: number, idle: number) =>
  'node_memory_MemTotal_bytes 1000\n' +
  'node_memory_MemAvailable_bytes 600\n' +
  'node_filesystem_size_bytes{device="/dev/sda",mountpoint="/",fstype="ext4"} 10000\n' +
  'node_filesystem_avail_bytes{device="/dev/sda",mountpoint="/",fstype="ext4"} 4000\n' +
  'node_cpu_seconds_total{cpu="0",mode="idle"} ' + idle + '\n' +
  'node_cpu_seconds_total{cpu="0",mode="user"} ' + (total - idle) + '\n';

describe("read-only Management Observer", () => {
  it("rejects public, credential-bearing or duplicate inventory endpoints", () => {
    expect(() => parseObserverConfig(JSON.stringify([
      {id:"management",role:"management",metricsUrl:"https://github.com/",services:[]},
    ]), token)).toThrow(/inventory/u);
    expect(() => parseObserverConfig(JSON.stringify([
      {id:"management",role:"management",metricsUrl:"http://user@10.7.0.1:9100/metrics",services:[]},
    ]), token)).toThrow(/inventory/u);
    expect(() => parseObserverConfig(JSON.stringify([
      {id:"management",role:"management",metricsUrl:"http://10.7.0.1:9100/metrics",services:[]},
      {id:"management",role:"builder",metricsUrl:"http://10.7.0.2:9100/metrics",services:[]},
    ]), token)).toThrow(/inventory/u);
  });

  it("refuses untrusted access without probing any host", async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const observer = new Observer(parseObserverConfig(inventory, token), fetcher);
    const result = await observer.handle(new Request("http://127.0.0.1:8791/v1/hosts"));
    expect(result.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await observer.handle(new Request("http://127.0.0.1:8791/healthz"))).status).toBe(200);
  });

  it("collects bounded memory/disk and counter-derived CPU without guessing first-use CPU", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => new Response(++calls < 2
      ? sample(100, 70) : sample(110, 75)));
    const observer = new Observer(parseObserverConfig(inventory, token), fetcher);
    const host = parseObserverConfig(inventory, token).targets[0]!;
    const first = await observer.observeHost(host);
    expect(first.state).toBe("healthy");
    expect(first.cpu.usedPercent).toBeNull();
    expect(first.reasons).toContain("cpu_baseline_pending");
    expect(first.memory.usedBytes).toBe(400);
    expect(first.disk.usedBytes).toBe(6000);
    const second = await observer.observeHost(host);
    expect(second.cpu.usedPercent).toBeCloseTo(50);
  });

  it("marks one unreachable host unavailable while retaining other hosts", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("10.7.0.31")) throw new Error("network down");
      return new Response(sample(120, 90));
    });
    const observer = new Observer(parseObserverConfig(inventory, token), fetcher);
    const result = await observer.handle(new Request("http://127.0.0.1:8791/v1/hosts", {
      headers: { Authorization: "Bearer " + token },
    }));
    expect(result.status).toBe(200);
    const data = await result.json() as { hosts: {id:string;state:string;freshness:string}[] };
    expect(data.hosts).toHaveLength(3);
    expect(data.hosts.find(x => x.id === "runtime")).toMatchObject({
      state:"unavailable", freshness:"absent",
    });
    expect(data.hosts.find(x => x.id === "management")?.state).toBe("healthy");
  });

  it("uses allowlisted services and refuses arbitrary paths and methods", async () => {
    const fetcher = vi.fn(async () => new Response("ok"));
    const observer = new Observer(parseObserverConfig(inventory, token), fetcher);
    const headers = { Authorization: "Bearer " + token };
    const services = await observer.handle(new Request(
      "http://127.0.0.1:8791/v1/hosts/management/services", { headers },
    ));
    expect(services.status).toBe(200);
    expect(await services.json()).toMatchObject({services:[{id:"coordination",state:"healthy"}]});
    expect((await observer.handle(new Request("http://127.0.0.1:8791/v1/hosts/evil", {
      headers,
    }))).status).toBe(404);
    expect((await observer.handle(new Request("http://127.0.0.1:8791/v1/hosts", {
      headers, method:"POST",
    }))).status).toBe(405);
  });
});
