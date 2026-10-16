import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test(
  "actual Provisioner executable remains unready and claims no work without producer capabilities",
  { timeout: 15000 },
  async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "praetorium-t09-process-gate-"));
    const credential = randomBytes(32).toString("base64url");
    const credentialPath = path.join(temporary, "service-token");
    await writeFile(credentialPath, credential, { mode: 0o600 });
    let requests = 0;
    const controlPlane = createServer((_request, response) => {
      requests++;
      response.writeHead(503).end();
    });
    const portReservation = createServer();
    let child;
    let exited;
    let output = "";
    try {
      const controlPort = await listen(controlPlane);
      const healthPort = await listen(portReservation);
      await new Promise((resolve) => portReservation.close(resolve));
      child = spawn(process.execPath, [path.join(root, "apps/provisioner/dist/main.js")], {
        cwd: temporary,
        env: {
          HOME: temporary,
          TMPDIR: temporary,
          PATH: path.dirname(process.execPath),
          PROVISIONER_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPort}`,
          PROVISIONER_CREDENTIAL_PATH: credentialPath,
          PROVISIONER_WORKER_ID: "owned-t09-gate-worker",
          PROVISIONER_CLUSTER_ID: "clu_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          PROVISIONER_NAMESPACE_PREFIX: "owned-t09-gate",
          PROVISIONER_CONTROL_NAMESPACE: "praetorium-system",
          PROVISIONER_CONTROL_SERVICE: "provisioner",
          PROVISIONER_INGRESS_NAMESPACE: "owned-ingress",
          PROVISIONER_INSTANCE_ACCESS_NAMESPACE: "owned-access",
          PROVISIONER_INSTANCE_ACCESS_SERVICE: "instance-access",
          PROVISIONER_HEALTH_PORT: String(healthPort),
          PROVISIONER_MAX_CPU_MILLI: "1000",
          PROVISIONER_MAX_MEMORY_MIB: "1024",
          PROVISIONER_MAX_EPHEMERAL_STORAGE_MIB: "1024",
          PROVISIONER_MAX_CAPACITY_AGE_MS: "30000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      exited = once(child, "exit");
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          output = (output + chunk.toString()).slice(-16384);
        });
      const origin = `http://127.0.0.1:${healthPort}`;
      let live;
      for (let attempt = 0; attempt < 100; attempt++) {
        live = await fetch(`${origin}/healthz`).catch(() => null);
        if (live) break;
        if (child.exitCode !== null)
          assert.fail("Provisioner exited before its health listener started");
        await delay(50);
      }
      assert.equal(live?.status, 200);
      const ready = await fetch(`${origin}/readyz`);
      assert.equal(ready.status, 503);
      assert.deepEqual(await ready.json(), { status: "not_ready" });
      const metrics = await fetch(`${origin}/metrics`).then((response) => response.text());
      assert.match(metrics, /runtime_capability_gate_closed/);
      await delay(250);
      assert.equal(requests, 0, "the capability gate must close before any Control Plane claim");
      assert.ok(
        !output.includes(credential),
        "mounted service credentials must not enter process logs",
      );
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await new Promise((resolve) => controlPlane.close(resolve));
      if (portReservation.listening) await new Promise((resolve) => portReservation.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
