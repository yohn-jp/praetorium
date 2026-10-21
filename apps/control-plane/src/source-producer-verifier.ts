import { SourceProducerResultSchema, canonicalSourceProof, sourceProofDigest } from "@praetorium/contracts";
import type { SourceProducerResult } from "@praetorium/contracts";
import type { D1Database } from "@praetorium/persistence/d1";
import type { GhcrRegistryClient } from "@praetorium/ghcr/registry";

export type SourceProofKey = {
  keyId: string;
  publicKeyBase64: string;
  revoked?: boolean;
  validFrom?: string;
  validUntil?: string;
};
const SOURCE_URI = /^https:\/\/control\.praetorium\.yohn\.jp\/internal\/source-proofs\/(sr_[0-9a-f-]{36})$/u;
export function sourceProofUri(jobId:string):string {
  if (!/^sr_[0-9a-f-]{36}$/u.test(jobId)) throw new TypeError("Invalid Source Build job");
  return "https://control.praetorium.yohn.jp/internal/source-proofs/" + jobId;
}
function decodeBase64(value:string):Uint8Array {
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
    throw new TypeError("Invalid Builder public key");
  return Uint8Array.from(atob(value),character=>character.charCodeAt(0));
}
export class SourceProducerProofVerifier {
  constructor(
    private readonly db:D1Database,
    private readonly registry:Pick<GhcrRegistryClient,"verifyImage">,
    private readonly builderKeys:readonly SourceProofKey[],
  ) {}
  async verify(job:{
    readonly job_id:string;readonly github_release_id:number;
    readonly source_id:string;readonly source_tag:string;
    readonly source_revision:string;readonly release_version:string;
  },candidate:unknown):Promise<SourceProducerResult> {
    const result=SourceProducerResultSchema.parse(candidate);
    const statement=result.statement;
    if(statement.jobId!==job.job_id || statement.sourceId!==job.source_id ||
      statement.githubReleaseId!==job.github_release_id ||
      statement.sourceTag!==job.source_tag ||
      statement.sourceRevision!==job.source_revision ||
      statement.releaseVersion!==job.release_version ||
      statement.runtimeBaseDigest!==result.catalog.runtimeBaseDigest ||
      statement.buildKitDigest!==result.catalog.buildKitDigest ||
      statement.sourceRevision!==result.catalog.producerRevision ||
      statement.sourceRevision!==result.runtimeMetadata.producerRevision ||
      statement.catalogDigest!==await sourceProofDigest(result.catalog) ||
      statement.runtimeMetadataDigest!==await sourceProofDigest(result.runtimeMetadata))
      throw new TypeError("Source evidence does not match the leased immutable Release");
    const key=this.builderKeys.find(x=>x.keyId===result.signature.keyId&&!x.revoked);
    if(!key)throw new TypeError("Source proof Builder key is not approved");
    const now=Date.now();
    if(key.validFrom && Date.parse(key.validFrom)>now ||
       key.validUntil && Date.parse(key.validUntil)<=now)
      throw new TypeError("Source proof Builder key is not active");
    const raw=decodeBase64(key.publicKeyBase64);
    const signature=decodeBase64(result.signature.signature);
    if(raw.length!==32 || signature.length!==64)throw new TypeError("Invalid signed Source proof");
    const cryptoKey=await crypto.subtle.importKey("raw",raw.buffer as ArrayBuffer,"Ed25519",false,["verify"]);
    const verified=await crypto.subtle.verify(
      "Ed25519",cryptoKey,signature.buffer as ArrayBuffer,
      new TextEncoder().encode(canonicalSourceProof(statement)),
    );
    if(!verified)throw new TypeError("Source Builder signature is not valid");
    for(const digest of [statement.runtimeBaseDigest,statement.buildKitDigest]) {
      const receipt=await this.registry.verifyImage(statement.imageRepository,digest,{os:"linux",architecture:"amd64"});
      if(receipt.manifestDigest!==digest || receipt.repository!==statement.imageRepository)
        throw new TypeError("Source OCI digest does not match signed evidence");
    }
    return result;
  }
  /** Reverify persisted Worker proof every time admission/Canary requests it. */
  async provenance(input:{
    readonly imageDigest:string;readonly signatureRef:string;readonly provenanceRef:string;
  }) {
    const match=SOURCE_URI.exec(input.signatureRef);
    if(!match || input.signatureRef!==input.provenanceRef)
      return {verified:false,evidence:["Source proof reference invalid"]};
    const job=await this.db.prepare(
      "SELECT job_id,github_release_id,source_id,source_tag,source_revision,release_version,result_json FROM source_release_builds WHERE job_id=? AND state IN ('produced','admitted')"
    ).bind(match[1]).first<{
      job_id:string;github_release_id:number;source_id:string;source_tag:string;
      source_revision:string;release_version:string;result_json:string|null;
    }>();
    if(!job?.result_json)return {verified:false,evidence:["Source proof not persisted"]};
    const proof=await this.verify(job,JSON.parse(job.result_json));
    if(proof.statement.runtimeBaseDigest!==input.imageDigest)
      return {verified:false,evidence:["Source image digest differs from proof"]};
    return {
      verified:true,
      signerIdentity:"praetorium-build-worker:"+proof.signature.keyId,
      evidence:["Ed25519 source provenance and immutable GitHub Release verified"],
      attestation:{
        bundleRef:input.signatureRef,
        predicateType:"https://praetorium.yohn.jp/attestation/source-build/v1",
        subjects:[
          {name:proof.statement.imageRepository,sha256:proof.statement.runtimeBaseDigest.slice(7)},
          {name:"scriptorium-build/v1/catalog.json",sha256:proof.statement.catalogDigest.slice(7)},
          {name:"scriptorium-platform/v1/runtime-metadata.json",sha256:proof.statement.runtimeMetadataDigest.slice(7)},
        ],
      },
    };
  }
}
