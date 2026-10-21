import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

test("Actions retain PR and main verification while removing publication and runtime admission", () => {
  assert.match(
    verificationWorkflow,
    /^on:\n {2}pull_request:\n {2}push:\n {4}branches:\n {6}- main/mu,
  );
  assert.doesNotMatch(
    verificationWorkflow,
    /workflow_dispatch|refs\/tags|packages:\s*write|PRAETORIUM_RELEASE_OPERATOR_TOKEN|RELEASE_OPERATOR_TOKEN|\/v1\/operator\/releases|release create/iu,
  );
  assert.match(verificationWorkflow, /service: build-worker/u);
  assert.match(verificationWorkflow, /push: false/u);
  assert.match(verificationWorkflow, /load: true/u);
  assert.match(verificationWorkflow, /jobs:\n {2}verify:/u);
  assert.match(
    verificationWorkflow,
    / {2}candidate-images:\n {4}if: github\.event_name == 'pull_request' \|\| \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\)/u,
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
  assert.doesNotMatch(verificationWorkflow, /secrets\.[A-Z0-9_]+/u);
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
    /PRAETORIUM_RELEASE_OPERATOR_TOKEN|packages:\s*write|admit_release:\s*true/iu,
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
