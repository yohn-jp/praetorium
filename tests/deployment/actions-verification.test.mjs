import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDirectory = path.join(root, ".github/workflows");
const verificationWorkflow = readFileSync(
  path.join(workflowDirectory, "publish-services.yml"),
  "utf8",
);
const serviceImageBuild = readFileSync(
  path.join(root, "scripts/ci/build-service-image-candidates.sh"),
  "utf8",
);
const sourceStableFixture = readFileSync(
  path.join(root, "scripts/ci/source-stable-fixture.mjs"),
  "utf8",
);

test("Actions keep PR builds read-only and publish platform services only from main", () => {
  assert.match(
    verificationWorkflow,
    /^on:\n {2}pull_request:\n {2}push:\n {4}branches:\n {6}- main/mu,
  );
  assert.doesNotMatch(
    verificationWorkflow,
    /workflow_dispatch|refs\/tags|PRAETORIUM_RELEASE_OPERATOR_TOKEN|RELEASE_OPERATOR_TOKEN|\/v1\/operator\/releases|release create/iu,
  );
  assert.match(verificationWorkflow, /service: build-worker/u);
  assert.match(verificationWorkflow, /push: false/u);
  assert.match(verificationWorkflow, /load: true/u);
  assert.match(verificationWorkflow, /jobs:\n {2}verify:/u);
  assert.match(
    verificationWorkflow,
    / {2}candidate-images:\n {4}if: github\.event_name == 'pull_request'/u,
  );
  assert.match(
    verificationWorkflow,
    / {2}source-stable-fixture:\n[\s\S]*?permissions:\n {6}contents: read/u,
  );
  assert.match(
    verificationWorkflow,
    /NODE_ENV: test\n {10}PRAETORIUM_SOURCE_FIXTURE_ARTIFACT_DIR: \$\{\{ runner\.temp \}\}\/praetorium-source-stable-evidence\n {8}run: node scripts\/ci\/source-stable-fixture\.mjs/u,
  );
  assert.match(
    verificationWorkflow,
    /name: Verify built fixture imports\n {8}run: node scripts\/ci\/source-stable-fixture\.mjs --check-imports/u,
  );
  assert.match(
    verificationWorkflow,
    /name: Upload bounded Source fixture evidence\n {8}if: always\(\)\n {8}uses: actions\/upload-artifact@v4/u,
  );
  assert.match(
    verificationWorkflow,
    /source-stable-fixture-result\.json\n {12}\$\{\{ runner\.temp \}\}\/praetorium-source-stable-evidence\/buildkitd\.log/u,
  );
  assert.match(
    verificationWorkflow,
    /PRAETORIUM_SOURCE_FIXTURE_ARTIFACT_DIR: \$\{\{ runner\.temp \}\}\/praetorium-source-stable-evidence/u,
  );
  assert.match(verificationWorkflow, /timeout-minutes: 180/u);
  const checkouts = [
    ...verificationWorkflow.matchAll(
      /uses: actions\/checkout@[^\n]+\n([\s\S]{0,180}?)(?=\n {6}- uses:|\n {6}- name:|\n\S|$)/gu,
    ),
  ];
  assert.ok(checkouts.length >= 4);
  for (const checkout of checkouts) {
    assert.match(
      checkout[1],
      /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u,
    );
    assert.match(checkout[1], /persist-credentials: false/u);
  }
  assert.match(verificationWorkflow, /permissions:\n {2}contents: read/u);
  assert.deepEqual([...verificationWorkflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)]
    .map((match) => match[1]), ["GITHUB_TOKEN"]);
  assert.match(verificationWorkflow,
    / {2}publish-images:\n {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/u);
  const publisher = verificationWorkflow.split("  publish-images:\n")[1].split("  kubernetes-admission:\n")[0];
  const candidates = verificationWorkflow.split("  candidate-images:\n")[1].split("  publish-images:\n")[0];
  assert.match(publisher, /packages: write/u);
  assert.match(publisher, /push: true/u);
  assert.match(publisher, /provenance: mode=max/u);
  assert.match(publisher, /service-image-\$\{\{ matrix.service \}\}/u);
  assert.doesNotMatch(candidates, /packages: write|secrets\./u);
  const buildKitClientImage =
    "docker.io/moby/buildkit@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c";
  assert.ok(
    verificationWorkflow.includes(buildKitClientImage),
    "PR image build uses the pinned v0.34 BuildKit client",
  );
  assert.ok(
    serviceImageBuild.includes(buildKitClientImage),
    "candidate script uses the same pinned BuildKit client",
  );
  assert.match(sourceStableFixture, /BUILDKIT_VERSION = "v0\.34\.0"/u);
  assert.doesNotMatch(sourceStableFixture, /from "@praetorium\//u);
});

test("Observer publication records its dedicated package and rejects mismatched receipt repositories", (t) => {
  const publisher = verificationWorkflow.split("  publish-images:\n")[1].split("  kubernetes-admission:\n")[0];
  assert.match(publisher, /service: observer\n[\s\S]*?image: management-observer/u);
  assert.match(publisher, /tags: ghcr\.io\/yohn-jp\/praetorium\/\$\{\{ matrix\.image \|\| matrix\.service \}\}:source-\$\{\{ github\.sha \}\}/u);
  assert.match(publisher, /IMAGE_REPOSITORY: yohn-jp\/praetorium\/\$\{\{ matrix\.image \|\| matrix\.service \}\}/u);
  const script = /node --input-type=module <<'JS'\n([\s\S]*?)\n {10}JS/u.exec(publisher)?.[1];
  assert.ok(script, "execute the actual workflow receipt writer");
  const directory = mkdtempSync(path.join(os.tmpdir(), "praetorium-ci-receipt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const service of ["provisioner", "instance-access", "build-worker", "coordination", "observer"]) {
    const repository = `yohn-jp/praetorium/${service === "observer" ? "management-observer" : service}`;
    const env = { ...process.env, RUNNER_TEMP: path.join(directory, service),
      GITHUB_RUN_ID: "42", IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
      IMAGE_REPOSITORY: repository, SERVICE: service, REVISION: "a".repeat(40) };
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const filename = path.join(env.RUNNER_TEMP, "service-image/receipt.json");
    const receipt = readFileSync(filename, "utf8");
    assert.deepEqual(JSON.parse(receipt), { schema: "praetorium.ci-service-image/v1",
      revision: env.REVISION, ciRunId: 42, service, repository, digest: env.IMAGE_DIGEST });
    for (const invalidRepository of ["other/repository", `${repository}-unexpected`]) {
      const invalid = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        env: { ...env, IMAGE_REPOSITORY: invalidRepository }, encoding: "utf8",
      });
      assert.notEqual(invalid.status, 0);
      assert.equal(readFileSync(filename, "utf8"), receipt);
    }
  }
});

test("legacy Actions producer publication and Admission workflows are absent", () => {
  for (const name of [
    "publish-existing-scriptorium-producer.yml",
    "publish-scriptorium-producer-inputs.yml",
    "scriptorium-producer-verification.yml",
  ]) {
    assert.equal(existsSync(path.join(workflowDirectory, name)), false, name);
  }
  for (const name of [
    "admit-produced-release.mjs",
    "checkout-selected-release.sh",
    "hosted-producer-verification.sh",
    "publish-producer-inputs.mjs",
    "validate-producer-attestation.mjs",
  ]) {
    assert.equal(existsSync(path.join(root, "scripts/ci", name)), false, name);
  }
  const workflows = readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => readFileSync(path.join(workflowDirectory, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    workflows,
    /PRAETORIUM_RELEASE_OPERATOR_TOKEN|admit_release:\s*true/iu,
  );
  const manualCandidates = readFileSync(
    path.join(workflowDirectory, "verify-service-images.yml"),
    "utf8",
  );
  assert.match(manualCandidates, /workflow_dispatch:/u);
  assert.match(manualCandidates, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.doesNotMatch(
    manualCandidates,
    /packages:\s*write|RELEASE_OPERATOR_TOKEN|operator\/releases/u,
  );
});
