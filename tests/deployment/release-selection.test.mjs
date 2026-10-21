import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAdmissionManifest } from "../../scripts/ci/admit-produced-release.mjs";

const sourceRevision = "a".repeat(40);
const digest = "sha256:" + "b".repeat(64);
const input = {
  sourceRevision, tag: "v0.2.1",version:"0.2.1",
  evidenceTag: "producer-evidence-39092494296-1",
  catalog: {
    contractVersion:"scriptorium-build/v1",producerRevision:sourceRevision,
    runtimeBaseDigest:digest,buildKitDigest:digest,
    modules:[],resourceProfiles:[],
  },
  runtimeMetadata: {contractVersion:"scriptorium-platform/v1",producerRevision:sourceRevision},
};

describe("canonical Operator Release manifest builder", () => {
  it("uses exact preverified catalog, metadata and public signed evidence", () => {
    const manifest = createAdmissionManifest(input);
    assert.equal(manifest.schemaVersion,1);
    assert.equal(manifest.version,"0.2.1");
    assert.equal(manifest.imageRepository,"ghcr.io/yohn-jp/praetorium/scriptorium-producer");
    assert.equal(manifest.catalog,input.catalog);
    assert.equal(manifest.runtimeMetadata,input.runtimeMetadata);
    assert.equal(manifest.signatureRef,
      "https://github.com/yohn-jp/praetorium/releases/download/producer-evidence-39092494296-1/provenance.sigstore.json");
    assert.equal(manifest.provenanceRef,manifest.signatureRef);
    assert.deepEqual(Object.keys(manifest).sort(),[
      "schemaVersion","version","imageRepository","catalog","runtimeMetadata","signatureRef","provenanceRef",
    ].sort());
  });
  it("refuses mismatched source, version and unsigned/invalid evidence", () => {
    for (const invalid of [
      {...input,version:"0.2.2"},
      {...input,tag:"arbitrary-commit"},
      {...input,sourceRevision:"not-a-sha"},
      {...input,evidenceTag:"/evil"},
      {...input,catalog:{...input.catalog,producerRevision:"c".repeat(40)}},
      {...input,catalog:{...input.catalog,runtimeBaseDigest:"latest"}},
      {...input,runtimeMetadata:{...input.runtimeMetadata,producerRevision:"c".repeat(40)}},
    ]) assert.throws(()=>createAdmissionManifest(invalid));
  });
});

describe("workflows retain selected immutable source and trusted issuer", () => {
  it("contains no hardcoded historic Scriptorium revision in executable entrypoints", async () => {
    for (const path of [
      ".github/workflows/scriptorium-producer-verification.yml",
      ".github/workflows/publish-scriptorium-producer-inputs.yml",
      "scripts/ci/validate-producer-attestation.mjs",
      "scripts/ci/publish-producer-inputs.mjs",
      "scripts/ci/hosted-producer-verification.sh",
    ]) {
      const text = await readFile(path,"utf8");
      assert.ok(!text.includes("008d5c429ec279a424cafd5b8c4cbee70a613b8e"),path);
    }
  });
  it("verifies GitHub Release/tag commit before running producer code", async () => {
    const workflow = await readFile(".github/workflows/scriptorium-producer-verification.yml","utf8");
    assert.match(workflow,/source_revision:/);
    assert.match(workflow,/source_tag:/);
    assert.match(workflow,/checkout-selected-release\.sh/);
    const checkout = await readFile("scripts/ci/checkout-selected-release.sh","utf8");
    assert.match(checkout,/refs\/tags\/\$tag/);
    assert.match(checkout,/GitHub Release is not published/);
    assert.match(checkout,/Published tag changed after operator selection/);
  });
  it("separates immutable signed publisher admission from Canary/Stable", async () => {
    const publisher=await readFile(".github/workflows/publish-scriptorium-producer-inputs.yml","utf8");
    assert.match(publisher,/provenance\.sigstore\.json/);
    assert.match(publisher,/PRAETORIUM_RELEASE_OPERATOR_TOKEN/);
    assert.match(publisher,/\/v1\/operator\/releases/);
    assert.ok(!publisher.includes("/promote-stable"));
    assert.match(publisher,/cmp -s "\$bundle"/);
  });
});
