import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { D1Database } from "@praetorium/persistence/d1";
import type { GhcrRegistryClient } from "@praetorium/ghcr/registry";
import { RegistryError } from "@praetorium/ghcr/registry";
import {
  SourceProducerResultSchemaV1,
  SourceProducerResultSchemaV2,
  canonicalSourceProof,
  sourceProofDigest,
} from "@praetorium/contracts";
import { SourceProducerProofVerifier } from "./source-producer-verifier.js";
import catalogFixture from "../../../plugins/scriptorium/test/fixtures/build-catalog.v1.fixture.json" with { type: "json" };

const legacyRevision="008d5c429ec279a424cafd5b8c4cbee70a613b8e";
const v021Revision="3189a85bfa28ddd160600a0188ab3ccfa91755e4";
const resolverDigest="sha256:2982c0d9595168b73b021da3229b30e7c4dd699ed86b6a728060f77cb3c2ea18";
const legacyProvenanceDigest="sha256:c81b71fff985aaf542d8fd6e2d76c0740ff9390f53f642d00da2fc6bd975db88";
const v021ProvenanceDigest="sha256:46dc7f209c1a074b5acdeb8a7111006cfb20e3c40f219bc3edbe910be2209cac";
const digestA="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const digestB="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE_REPOSITORY="ghcr.io/yohn-jp/praetorium/scriptorium-producer";
const job={
  job_id:"sr_11111111-1111-4111-8111-111111111111",
  github_release_id:1,
  source_id:"scriptorium",
  source_tag:"v0.1.0",
  source_revision:legacyRevision,
  release_version:"0.1.0",
} as const;
const v021Job={
  ...job,
  github_release_id:416422590,
  source_tag:"v0.2.1",
  source_revision:v021Revision,
  release_version:"0.2.1",
} as const;

const keyPair=generateKeyPairSync("ed25519");
const publicKeyBase64=keyPair.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64");
const builderKeys=[{keyId:"test-builder",publicKeyBase64}];

function fixtureCatalog(revision=legacyRevision) {
  return {
    ...catalogFixture,
    producerRevision:revision,
    runtimeBaseDigest:digestA,
    buildKitDigest:digestB,
  };
}

const runtimeMetadata={
  contractVersion:"scriptorium-platform/v1",
  producerRevision:legacyRevision,
  listener:{port:3000},
  paths:{
    liveness:"/healthz",readiness:"/readyz",metadata:"/api/platform/v1/metadata",
    shutdown:"/api/platform/v1/shutdown",status:"/api/platform/v1/status",
    quiesce:"/api/platform/v1/quiesce",resume:"/api/platform/v1/resume",
  },
  shutdownTimeoutSeconds:25,
} as const;

async function signedStatement(statement: Record<string, unknown>) {
  return edSign(null,Buffer.from(canonicalSourceProof(statement),"utf8"),keyPair.privateKey).toString("base64");
}

function registry(host="ghcr.io") {
  const verifyImage=vi.fn(async (repository:string,manifestDigest:string) =>
    ({repository,manifestDigest}) as unknown as Awaited<ReturnType<GhcrRegistryClient["verifyImage"]>>);
  return {client:{registryHost:host,verifyImage},verifyImage};
}

function verifier(client: ReturnType<typeof registry>["client"],sourceProducerRepository:string|undefined=SOURCE_REPOSITORY) {
  return new SourceProducerProofVerifier(
    null as unknown as D1Database,
    client as unknown as Pick<GhcrRegistryClient,"verifyImage"|"registryHost">,
    builderKeys,
    undefined,
    sourceProducerRepository,
  );
}

function sourceProofDatabase(resultJson:string|null) {
  const row={...job,result_json:resultJson};
  return {
    prepare:vi.fn(()=>({bind:vi.fn(()=>({first:vi.fn(async()=>row)}))})),
  } as unknown as D1Database;
}

async function legacyProof(revision=legacyRevision) {
  const catalog=fixtureCatalog(revision);
  const statement={
    schemaVersion:1,
    jobId:job.job_id,
    githubReleaseId:job.github_release_id,
    sourceId:"scriptorium",
    sourceRepository:"yohn-jp/scriptorium",
    sourceTag:job.source_tag,
    sourceRevision:revision,
    releaseVersion:job.release_version,
    imageRepository:"ghcr.io/yohn-jp/praetorium/scriptorium-producer",
    runtimeBaseDigest:digestA,
    buildKitDigest:digestB,
    catalogDigest:await sourceProofDigest(catalog),
    runtimeMetadataDigest:await sourceProofDigest(runtimeMetadata),
  };
  return SourceProducerResultSchemaV1.parse({
    statement,
    signature:{algorithm:"Ed25519",keyId:"test-builder",signature:await signedStatement(statement)},
    catalog,
    runtimeMetadata,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("source producer proof verification", () => {
  it("accepts the explicit legacy v1 producer and passes only the allowlisted repository path", async () => {
    const {client,verifyImage}=registry();
    const result=await verifier(client).verify(job,await legacyProof());
    expect(result.statement.schemaVersion).toBe(1);
    expect(verifyImage).toHaveBeenCalledTimes(2);
    expect(verifyImage).toHaveBeenCalledWith("yohn-jp/praetorium/scriptorium-producer",digestA,{os:"linux",architecture:"amd64"});
  });

  it("rejects a v1 proof for a producer revision without the legacy resolver", async () => {
    const {client,verifyImage}=registry();
    const proof=await legacyProof("3189a85bfa28ddd160600a0188ab3ccfa91755e4");
    await expect(verifier(client).verify({ ...job, source_revision:proof.statement.sourceRevision },proof))
      .rejects.toMatchObject({retryable:false,code:"SOURCE_VERIFICATION_FAILED"});
    expect(verifyImage).not.toHaveBeenCalled();
  });

  it("classifies a different leased source tuple as SOURCE_CHANGED", async () => {
    const {client,verifyImage}=registry();
    await expect(verifier(client).verify({...job,source_tag:"v0.2.0"},await legacyProof()))
      .rejects.toMatchObject({retryable:false,code:"SOURCE_CHANGED"});
    expect(verifyImage).not.toHaveBeenCalled();
  });

  it("rejects registry host mismatch before registry access", async () => {
    const {client,verifyImage}=registry("registry-attacker.example");
    await expect(verifier(client).verify(job,await legacyProof()))
      .rejects.toMatchObject({retryable:false,code:"SOURCE_VERIFICATION_FAILED"});
    expect(verifyImage).not.toHaveBeenCalled();
  });

  it("requires v2 resolver identity and signed bundle digest to match the approved static entry", async () => {
    const {client,verifyImage}=registry();
    const catalog=fixtureCatalog(v021Revision);
    const metadata={...runtimeMetadata,producerRevision:v021Revision};
    const statement={
      schemaVersion:2,
      jobId:v021Job.job_id,
      githubReleaseId:v021Job.github_release_id,
      sourceId:"scriptorium",
      sourceRepository:"yohn-jp/scriptorium",
      sourceTag:v021Job.source_tag,
      sourceRevision:v021Revision,
      releaseVersion:v021Job.release_version,
      imageRepository:"ghcr.io/yohn-jp/praetorium/scriptorium-producer",
      runtimeBaseDigest:digestA,
      buildKitDigest:digestB,
      catalogDigest:await sourceProofDigest(catalog),
      runtimeMetadataDigest:await sourceProofDigest(metadata),
      resolverDigest,
    };
    const proof=SourceProducerResultSchemaV2.parse({
      statement,
      signature:{algorithm:"Ed25519",keyId:"test-builder",signature:await signedStatement(statement)},
      catalog,
      runtimeMetadata:metadata,
      resolver:{
        producerRevision:v021Revision,
        resolverRevision:resolverDigest,
        contractVersion:"scriptorium-build/v1",
        provenanceDigest:v021ProvenanceDigest,
      },
    });
    await expect(verifier(client).verify(v021Job,proof)).resolves.toMatchObject({
      statement:{schemaVersion:2,sourceRevision:v021Revision},
    });
    expect(verifyImage).toHaveBeenCalledTimes(2);

    const changed={
      ...proof,
      resolver:{...proof.resolver,provenanceDigest:legacyProvenanceDigest},
    };
    await expect(verifier(client).verify(v021Job,changed))
      .rejects.toMatchObject({retryable:false,code:"SOURCE_VERIFICATION_FAILED"});
    const wrongProducerRevision={
      ...proof,
      resolver:{...proof.resolver,producerRevision:legacyRevision},
    };
    await expect(verifier(client).verify(v021Job,wrongProducerRevision))
      .rejects.toMatchObject({retryable:false,code:"SOURCE_VERIFICATION_FAILED"});
    expect(verifyImage).toHaveBeenCalledTimes(2);
  });

  it("fails closed on v2 when operator policy has no exact producer repository", async () => {
    const {client,verifyImage}=registry();
    const proof=await legacyProof();
    const statement={
      ...proof.statement,
      schemaVersion:2,
      resolverDigest,
    };
    const catalog=proof.catalog;
    const v2=SourceProducerResultSchemaV2.parse({
      statement,
      signature:{...proof.signature,signature:await signedStatement(statement)},
      catalog,
      runtimeMetadata:proof.runtimeMetadata,
      resolver:{
        producerRevision:legacyRevision,
        resolverRevision:resolverDigest,
        contractVersion:"scriptorium-build/v1",
        provenanceDigest:"sha256:c81b71fff985aaf542d8fd6e2d76c0740ff9390f53f642d00da2fc6bd975db88",
      },
    });
    const unconfigured=new SourceProducerProofVerifier(
      null as unknown as D1Database,
      client as unknown as Pick<GhcrRegistryClient,"verifyImage"|"registryHost">,
      builderKeys,
    );
    await expect(unconfigured.verify(job,v2)).rejects.toMatchObject({
      retryable:false,code:"SOURCE_VERIFICATION_FAILED",
    });
    expect(verifyImage).not.toHaveBeenCalled();
  });

  it("classifies registry availability and authorization failures as retryable without admitting", async () => {
    const transient={
      registryHost:"ghcr.io",
      verifyImage:vi.fn(async()=>{throw new RegistryError("rate_limited","private detail");}),
    };
    await expect(verifier(transient).verify(job,await legacyProof())).rejects.toMatchObject({
      name:"SourceProofVerificationError",retryable:true,code:"SOURCE_VERIFICATION_FAILED",
    });

    const missing={
      registryHost:"ghcr.io",
      verifyImage:vi.fn(async()=>{throw new RegistryError("not_found","private detail");}),
    };
    await expect(verifier(missing).verify(job,await legacyProof())).rejects.toMatchObject({
      name:"SourceProofVerificationError",retryable:true,code:"SOURCE_VERIFICATION_FAILED",
    });
    expect(missing.verifyImage).toHaveBeenCalledTimes(2);

    let registryAvailable=false;
    const recovers={
      registryHost:"ghcr.io",
      verifyImage:vi.fn(async(repository:string,manifestDigest:string)=>{
        if(!registryAvailable)throw new RegistryError("not_found","private detail");
        return {repository,manifestDigest} as unknown as Awaited<ReturnType<GhcrRegistryClient["verifyImage"]>>;
      }),
    };
    const proof=await legacyProof();
    await expect(verifier(recovers).verify(job,proof)).rejects.toMatchObject({retryable:true});
    registryAvailable=true;
    await expect(verifier(recovers).verify(job,proof)).resolves.toMatchObject({statement:proof.statement});

    const denied={
      registryHost:"ghcr.io",
      verifyImage:vi.fn(async()=>{throw new RegistryError("unauthorized","private detail");}),
    };
    await expect(verifier(denied).verify(job,proof)).rejects.toMatchObject({
      name:"SourceProofVerificationError",retryable:true,code:"SOURCE_VERIFICATION_FAILED",
    });
    expect(denied.verifyImage).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid persisted signature evidence but leaves registry outages retryable", async () => {
    const valid=await legacyProof();
    const changedSignature=Buffer.from(valid.signature.signature,"base64");
    changedSignature[0]=changedSignature[0]!^1;
    const invalid={
      ...valid,
      signature:{...valid.signature,signature:changedSignature.toString("base64")},
    };
    const {client,verifyImage}=registry();
    const permanent=new SourceProducerProofVerifier(
      sourceProofDatabase(JSON.stringify(invalid)),client as unknown as Pick<GhcrRegistryClient,"verifyImage"|"registryHost">,
      builderKeys,
    );
    const proofUri=`https://control.praetorium.yohn.jp/internal/source-proofs/${job.job_id}`;
    await expect(permanent.provenance({imageDigest:digestA,signatureRef:proofUri,provenanceRef:proofUri}))
      .resolves.toMatchObject({verified:false,evidence:["Source proof verification failed"]});
    expect(verifyImage).not.toHaveBeenCalled();

    const unavailable={
      registryHost:"ghcr.io",
      verifyImage:vi.fn(async()=>{throw new RegistryError("unavailable","private detail");}),
    };
    const retryable=new SourceProducerProofVerifier(
      sourceProofDatabase(JSON.stringify(valid)),
      unavailable as unknown as Pick<GhcrRegistryClient,"verifyImage"|"registryHost">,
      builderKeys,
    );
    await expect(retryable.provenance({imageDigest:digestA,signatureRef:proofUri,provenanceRef:proofUri}))
      .rejects.toMatchObject({retryable:true,code:"SOURCE_VERIFICATION_FAILED"});
    expect(unavailable.verifyImage).toHaveBeenCalledTimes(2);
  });

  it("returns a rejected result for malformed persisted proof JSON", async () => {
    const {client,verifyImage}=registry();
    const verifierWithBadStoredJson=new SourceProducerProofVerifier(
      sourceProofDatabase("{"),
      client as unknown as Pick<GhcrRegistryClient,"verifyImage"|"registryHost">,
      builderKeys,
    );
    const proofUri=`https://control.praetorium.yohn.jp/internal/source-proofs/${job.job_id}`;
    await expect(verifierWithBadStoredJson.provenance({
      imageDigest:digestA,signatureRef:proofUri,provenanceRef:proofUri,
    })).resolves.toMatchObject({verified:false,evidence:["Source proof record is invalid"]});
    expect(verifyImage).not.toHaveBeenCalled();
  });
});
