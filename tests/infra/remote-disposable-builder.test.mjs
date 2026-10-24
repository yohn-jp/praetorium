import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  BUILDER_OWNER,
  createCgroupReceipt,
  createBuilderJournal,
  createOwnerMarker,
  createT14ChildEnvironment,
  kubectlClientGitVersion,
  ownerSubidMappingStatus,
  renderMountUnit,
  renderSliceUnit,
  validateBuilderJournal,
  validateCgroupReceipt,
  validateOwnerMarker,
  writeOwnerMarker,
} from "../../scripts/remote-disposable-builder-state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/remote-disposable-builder.sh");
const stateSource = readFileSync(
  path.join(root, "scripts/remote-disposable-builder-state.mjs"),
  "utf8",
);
const source = readFileSync(script, "utf8");

test("remote Builder helper is syntax-valid and offers only explicit bounded actions", () => {
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /\$action == plan \|\| \$action == setup \|\| \$action == run/u);
  assert.match(source, /IMAGE_BYTES=6442450944/u);
  assert.match(renderSliceUnit(), /CPUQuota=200%[\s\S]*MemoryMax=4G[\s\S]*TasksMax=2048/u);
  assert.match(source, /testport=10\.7\.0\.32:1235/u);
});

test("remote Builder helper isolates state and leaves production BuildKit protected", () => {
  assert.match(source, /podman version 5\.7\.0/u);
  assert.match(source, /need fuse-overlayfs/u);
  assert.match(source, /kind v0\.31\.0/u);
  assert.match(source, /v1\.35\.0/u);
  assert.match(source, /graphroot = "\$MOUNT\/podman\/graphroot/u);
  assert.match(source, /systemctl is-active praetorium-buildkit\.service/u);
  assert.match(source, /10\\\.7\\\.0\\\.32:1234/u);
  assert.doesNotMatch(
    source,
    /systemctl\s+(?:stop|restart|disable)\s+praetorium-buildkit\.service/u,
  );
  assert.doesNotMatch(source, /podman\s+system\s+reset|kind\s+delete\s+clusters/u);
  assert.match(source, /verify_marker[\s\S]*cmp -s "\$MARKER" "\$MOUNT\//u);
  assert.match(source, /KIND_EXPERIMENTAL_PROVIDER=podman kind delete cluster --name "\$CLUSTER"/u);
  assert.match(source, /journal-init[\s\S]*journal-stage[\s\S]*journal-remove/u);
  assert.match(source, /useradd --system --user-group/u);
  assert.match(source, /runuser --user "\$OWNER" -- "\$ENV_BIN" -i/u);
  assert.doesNotMatch(source, /runuser --login/u);
  assert.doesNotMatch(source, /\bHOME=/u);
  assert.match(source, /cgroup_manager = "cgroupfs"/u);
  assert.doesNotMatch(source, /systemd-run --scope/u);
  assert.match(source, /TemporaryFileSystem=\/tmp:size=512M/u);
  assert.match(source, /TemporaryFileSystem=\/var\/tmp:size=128M/u);
  assert.match(source, /ProtectSystem=strict/u);
  assert.match(source, /ReadWritePaths=\$MOUNT \/run\/user\/\$test_uid/u);
  assert.match(source, /SetLoginEnvironment=yes/u);
  assert.match(source, /UnsetEnvironment=GITHUB_TOKEN GH_TOKEN CLOUDFLARE_API_TOKEN/u);
  assert.match(source, /--wait --pipe --collect[\s\S]*--property=Type=exec/u);
  assert.match(source, /Environment=KUBECONFIG=\$MOUNT\/kube\/config/u);
  assert.match(source, /WorkingDirectory=\$MOUNT\/home/u);
  assert.match(source, /"\$STATE_MODULE" exec -- \/bin\/bash/u);
  assert.match(stateSource, /process\.env\.HOME !== account\.homedir/u);
  assert.match(source, /systemctl show "\$probe" -p ControlGroup/u);
  assert.match(source, /verify_root_staged_file "\$\{BASH_SOURCE\[0\]\}" true/u);
  assert.match(source, /verify_root_staged_file "\$STATE_MODULE" false/u);
  assert.match(source, /stat -c '%u' "\$directory"\) == 0/u);
  assert.match(source, /directory_mode & 0022\) == 0/u);
  assert.match(source, /canonical == "\$lexical"/u);
  const stagedHelpersCheck = source.indexOf("if (( EUID == 0 )); then verify_runtime_helpers; fi");
  const firstRootAction = source.indexOf("if [[ $action == plan ]]");
  assert.ok(stagedHelpersCheck >= 0 && stagedHelpersCheck < firstRootAction);
});

test("cleanup never deletes cross-run temporary paths and blocks active test services before removal", () => {
  assert.doesNotMatch(source, /praetorium-t12-\$test_uid/u);
  assert.match(source, /KUBECONFIG=\$MOUNT\/kube\/config/u);
  assert.match(source, /--state=active,activating,deactivating,reloading/u);
  assert.match(source, /'praetorium-t14-\*\.service' "\$TEST_BUILDKIT_UNIT"/u);
  const cleanupStart = source.indexOf('verify_marker\ngetent passwd "$OWNER"');
  const activeGuard = source.indexOf("verify_no_active_t14_command_units", cleanupStart);
  const journalRemoval = source.indexOf(
    'node "$STATE_MODULE" journal-remove "$JOURNAL"',
    cleanupStart,
  );
  const receiptRemoval = source.indexOf('rm -f "$CGROUP_RECEIPT"', cleanupStart);
  const clusterDelete = source.indexOf('kind delete cluster --name "$CLUSTER"', cleanupStart);
  assert.ok(cleanupStart >= 0);
  assert.ok(activeGuard > cleanupStart);
  assert.ok(journalRemoval > activeGuard);
  assert.ok(receiptRemoval > activeGuard);
  assert.ok(clusterDelete > activeGuard);
});

test("pretty kubectl version JSON is parsed structurally", () => {
  const prettyOutput = `{
    "clientVersion": {
      "gitVersion": "v1.35.0",
      "major": "1",
      "minor": "35"
    }
  }\n`;
  assert.equal(kubectlClientGitVersion(prettyOutput), "v1.35.0");
  const parsedByCli = spawnSync(
    process.execPath,
    [path.join(root, "scripts/remote-disposable-builder-state.mjs"), "kubectl-version"],
    { encoding: "utf8", input: prettyOutput },
  );
  assert.equal(parsedByCli.status, 0, parsedByCli.stderr);
  assert.equal(parsedByCli.stdout.trim(), "v1.35.0");
  assert.equal(kubectlClientGitVersion('{"clientVersion":{"gitVersion":"v1.34.0"}}'), "v1.34.0");
  assert.throws(() => kubectlClientGitVersion('{"clientVersion": {}}'), /missing or malformed/u);
  assert.throws(() => kubectlClientGitVersion("not json"), /not valid JSON/u);
});

test("runuser accepts the harmless disposable invocation and env -i removes ambient credentials", (t) => {
  if (typeof process.getuid === "function" && process.getuid() !== 0)
    return t.skip("runuser command execution requires root on this platform");
  const base = ["--user", "nobody", "--"];
  const result = spawnSync("runuser", [...base, process.execPath, "-e", ""], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error?.code === "ENOENT") return t.skip("runuser unavailable");
  assert.equal(result.status, 0, result.stderr);
  const envBinary = ["/usr/bin/env", "/bin/env", "/run/current-system/sw/bin/env"].find(existsSync);
  if (!envBinary) return t.skip("env unavailable");
  const withEnv = spawnSync(
    "runuser",
    [
      ...base,
      envBinary,
      "-i",
      "PATH=/usr/bin:/bin",
      "XDG_CONFIG_HOME=/tmp/praetorium-t14-test-config",
      "XDG_DATA_HOME=/tmp/praetorium-t14-test-data",
      "XDG_RUNTIME_DIR=/tmp/praetorium-t14-test-runtime",
      "CONTAINERS_STORAGE_CONF=/tmp/praetorium-t14-storage.conf",
      "KIND_EXPERIMENTAL_PROVIDER=podman",
      process.execPath,
      "-e",
      "if (process.env.GITHUB_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.HTTP_PROXY) process.exit(42)",
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        GITHUB_TOKEN: "test-canary-no-output",
        CLOUDFLARE_API_TOKEN: "test-canary-no-output",
        HTTP_PROXY: "http://127.0.0.1:9",
      },
    },
  );
  assert.equal(withEnv.status, 0, withEnv.stderr);
});

test("the cleanup allowlist strips ambient credential and proxy canaries without printing them", (t) => {
  const envBinary = ["/usr/bin/env", "/bin/env", "/run/current-system/sw/bin/env"].find(existsSync);
  if (!envBinary) return t.skip("env unavailable");
  const result = spawnSync(
    envBinary,
    [
      "-i",
      "PATH=/usr/bin:/bin",
      process.execPath,
      "-e",
      "if (process.env.GITHUB_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.HTTP_PROXY) process.exit(42)",
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        GITHUB_TOKEN: "canary-value-never-print",
        CLOUDFLARE_API_TOKEN: "canary-value-never-print",
        HTTP_PROXY: "http://127.0.0.1:9",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /canary-value-never-print/u);
});

test("the T14 child environment preserves the systemd account HOME and drops unknown secrets", () => {
  const sourceEnvironment = {
    HOME: "/var/lib/praetorium-t14/state/home",
    USER: "praetorium-t14",
    LOGNAME: "praetorium-t14",
    SHELL: "/bin/bash",
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    XDG_CONFIG_HOME: "/var/lib/praetorium-t14/state/home/.config",
    REGISTRY_AUTH_FILE: "/var/lib/praetorium-t14/state/credentials/registry-auth.json",
    GITHUB_TOKEN: "canary-never-print",
    CLOUDFLARE_API_TOKEN: "canary-never-print",
    HTTP_PROXY: "http://127.0.0.1:9",
    SECRET_NOT_STANDARD: "canary-never-print",
  };
  const childEnvironment = createT14ChildEnvironment(sourceEnvironment);
  assert.equal(childEnvironment.HOME, sourceEnvironment.HOME);
  assert.equal(childEnvironment.USER, sourceEnvironment.USER);
  assert.equal(childEnvironment.REGISTRY_AUTH_FILE, sourceEnvironment.REGISTRY_AUTH_FILE);
  assert.equal(Object.hasOwn(childEnvironment, "GITHUB_TOKEN"), false);
  assert.equal(Object.hasOwn(childEnvironment, "CLOUDFLARE_API_TOKEN"), false);
  assert.equal(Object.hasOwn(childEnvironment, "HTTP_PROXY"), false);
  assert.equal(Object.hasOwn(childEnvironment, "SECRET_NOT_STANDARD"), false);
  assert.doesNotMatch(JSON.stringify(childEnvironment), /canary-never-print/u);
  assert.throws(
    () => createT14ChildEnvironment({ ...sourceEnvironment, HOME: undefined }),
    /HOME/u,
  );
});

test("systemd-run parses bounded transient-service options without applying a unit", (t) => {
  const result = spawnSync(
    "systemd-run",
    [
      "--wait",
      "--pipe",
      "--collect",
      "--slice=praetorium-t14.slice",
      "--unit=praetorium-t14-cli-parse.service",
      "--uid=nobody",
      "--property=Delegate=yes",
      "--property=Type=exec",
      "--property=SetLoginEnvironment=yes",
      "--property=ProtectSystem=strict",
      "--property=TemporaryFileSystem=/tmp:size=512M",
      "--property=TemporaryFileSystem=/var/tmp:size=128M",
      "--property=ReadWritePaths=/var/lib/praetorium-t14/state /run/user/65534",
      "--property=WorkingDirectory=/var/lib/praetorium-t14/state/home",
      "--property=UnsetEnvironment=GITHUB_TOKEN GH_TOKEN CLOUDFLARE_API_TOKEN HTTP_PROXY",
      "--property=Environment=PATH=/usr/local/bin:/usr/bin:/bin",
      "--help",
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.error?.code === "ENOENT") return t.skip("systemd-run unavailable");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /systemd-run \[OPTIONS\.\.\.\] COMMAND/u);
});

test("T14 subordinate ID ownership requires exactly the one expected mapping", () => {
  assert.equal(
    ownerSubidMappingStatus(
      "other:3000000:65536\npraetorium-t14:3000000:65536\n",
      "praetorium-t14",
      3000000,
      65536,
    ),
    "exact",
  );
  assert.equal(
    ownerSubidMappingStatus("other:100000:65536\n", "praetorium-t14", 3000000, 65536),
    "missing",
  );
  assert.throws(
    () =>
      ownerSubidMappingStatus(
        "praetorium-t14:3000000:65536\npraetorium-t14:4000000:65536\n",
        "praetorium-t14",
        3000000,
        65536,
      ),
    /single expected range/u,
  );
  assert.throws(
    () =>
      ownerSubidMappingStatus("praetorium-t14:3000000:32768\n", "praetorium-t14", 3000000, 65536),
    /single expected range/u,
  );
  assert.throws(
    () =>
      ownerSubidMappingStatus("praetorium-t14:3000000:65535\n", "praetorium-t14", 3000000, 65536),
    /single expected range/u,
  );
});

test("T14 marker serializes and parses the escaped mount unit as valid JSON", () => {
  const marker = createOwnerMarker({
    filesystemUuid: "01234567-89ab-cdef-0123-456789abcdef",
    mountUnitSha256: "a".repeat(64),
    sliceUnitSha256: "b".repeat(64),
    ownerUid: 2000,
    ownerGid: 2000,
    now: new Date("2026-10-25T00:00:00.000Z"),
  });
  const serialized = JSON.stringify(marker);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.mountUnit, "var-lib-praetorium\\x2dt14-state.mount");
  assert.equal(validateOwnerMarker(parsed), parsed);
  assert.throws(
    () => JSON.parse('{"mountUnit":"var-lib-praetorium\\x2dt14-state.mount"}'),
    SyntaxError,
  );
});

test("owner marker writer emits valid private JSON and setup journal is durably initialized", async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-t14-marker-"));
  try {
    const markerPath = path.join(temporary, "owner.json");
    const marker = createOwnerMarker({
      filesystemUuid: "01234567-89ab-cdef-0123-456789abcdef",
      mountUnitSha256: "a".repeat(64),
      sliceUnitSha256: "b".repeat(64),
      ownerUid: 2000,
      ownerGid: 2000,
    });
    await writeOwnerMarker(markerPath, marker);
    assert.equal(
      validateOwnerMarker(JSON.parse(readFileSync(markerPath, "utf8"))).mountUnit,
      BUILDER_OWNER.mountUnit,
    );
    assert.equal(statSync(markerPath).mode & 0o777, 0o600);

    const journalPath = path.join(temporary, "setup-journal.json");
    const journal = spawnSync(
      process.execPath,
      [path.join(root, "scripts/remote-disposable-builder-state.mjs"), "journal-init", journalPath],
      { encoding: "utf8" },
    );
    assert.equal(journal.status, 0, journal.stderr);
    assert.equal(
      validateBuilderJournal(JSON.parse(readFileSync(journalPath, "utf8"))).stage,
      "reserved",
    );
    assert.equal(statSync(journalPath).mode & 0o777, 0o600);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup journal has a validated forward-only recovery lifecycle", () => {
  const reserved = createBuilderJournal();
  assert.equal(validateBuilderJournal(reserved), reserved);
  const mounted = {
    ...reserved,
    stage: "mounted",
    uid: 2000,
    gid: 2000,
    filesystemUuid: "01234567-89ab-cdef-0123-456789abcdef",
  };
  assert.equal(validateBuilderJournal(mounted).stage, "mounted");
  assert.equal(validateBuilderJournal({ ...mounted, stage: "ready" }).stage, "ready");
  assert.throws(() => validateBuilderJournal({ ...reserved, stage: "unknown" }), /stage/u);
  assert.throws(() => validateBuilderJournal({ ...reserved, owner: "buildkit" }), /owner/u);
});

test("only a fresh readback of the live T14 cgroup limits authorizes bounded run", () => {
  const receipt = createCgroupReceipt({ ownerUid: 2000, sliceUnitSha256: "c".repeat(64) });
  assert.equal(
    validateCgroupReceipt(receipt, { ownerUid: 2000, sliceUnitSha256: "c".repeat(64) }),
    receipt,
  );
  assert.throws(
    () => validateCgroupReceipt(receipt, { ownerUid: 2001, sliceUnitSha256: "c".repeat(64) }),
    /owner UID/u,
  );
  assert.throws(() => validateCgroupReceipt({ ...receipt, memoryMax: "max" }), /memoryMax/u);
  const stale = createCgroupReceipt({
    ownerUid: 2000,
    sliceUnitSha256: "c".repeat(64),
    now: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });
  assert.throws(() => validateCgroupReceipt(stale), /stale/u);
});

test("rendered mount and resource-limit slice units pass systemd syntax verification", (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-t14-units-"));
  try {
    const mountPath = path.join(temporary, BUILDER_OWNER.mountUnit);
    const slicePath = path.join(temporary, BUILDER_OWNER.sliceUnit);
    writeFileSync(mountPath, renderMountUnit(), { mode: 0o600 });
    writeFileSync(slicePath, renderSliceUnit(), { mode: 0o600 });
    assert.match(renderMountUnit(), /Options=loop,nodev,nosuid/u);
    assert.match(renderSliceUnit(), /CPUQuota=200%[\s\S]*MemoryMax=4G[\s\S]*TasksMax=2048/u);
    const verify = spawnSync("systemd-analyze", ["verify", mountPath, slicePath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (verify.error?.code === "ENOENT") return t.skip("systemd-analyze unavailable");
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
