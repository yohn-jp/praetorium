import { spawn } from "node:child_process";
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { createBuildctlRunner } from "@praetorium/buildkit";
import {
  BuildCatalogSchema, RuntimeMetadataSchema, SourceProducerResultSchema,
  canonicalSourceProof, sourceProofDigest, type SourceProducerResult,
} from "@praetorium/contracts";
import type { BuildWorkerConfig } from "./config.js";

const REPO="https://github.com/yohn-jp/scriptorium.git";
const IMAGE="ghcr.io/yohn-jp/praetorium/scriptorium-producer";
const SHA=/^[a-f0-9]{40}$/u;
const TAG=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DIGEST=/^sha256:[a-f0-9]{64}$/u;

export interface SourceBuildClaim {
  job_id:string; source_id:"scriptorium"; source_repository:"yohn-jp/scriptorium";
  github_release_id:number; source_tag:string;source_revision:string;
  release_version:string; actor_id:string;
  lease_worker:string;lease_token:string;lease_epoch:number;lease_expires_at:number;
}

/** Do not execute producer source in the privileged Worker process. Only the
 * remote isolated BuildKit daemon executes the Scriptorium Dockerfile. */
function assertClaim(job:SourceBuildClaim):void{
  if(!/^sr_[a-f0-9-]{36}$/u.test(job.job_id)||
     job.source_id!=="scriptorium"||job.source_repository!=="yohn-jp/scriptorium"||
     !Number.isSafeInteger(job.github_release_id)||job.github_release_id<=0||
     !SHA.test(job.source_revision)||!TAG.test(job.source_tag)||
     job.source_tag.replace(/^v/u,"")!==job.release_version)
    throw new TypeError("Untrusted source Producer job");
}

async function git(args:readonly string[],cwd:string,signal:AbortSignal):Promise<string>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error("Canceled"));return;}
    const child=spawn("git",args,{
      cwd, shell:false,windowsHide:true,
      env:{PATH:"/usr/local/bin:/usr/bin:/bin",HOME:cwd,LANG:"C",
        GIT_CONFIG_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",
        GIT_CONFIG_COUNT:"2",GIT_CONFIG_KEY_0:"core.hooksPath",GIT_CONFIG_VALUE_0:"/dev/null",
        GIT_CONFIG_KEY_1:"protocol.file.allow",GIT_CONFIG_VALUE_1:"never"},
      stdio:["ignore","pipe","pipe"],
    });
    let out="",size=0;
    const timer=setTimeout(()=>child.kill("SIGKILL"),60_000);timer.unref();
    const abort=()=>child.kill("SIGKILL");
    signal.addEventListener("abort",abort,{once:true});
    child.stdout.on("data",(buf:Buffer)=>{size+=buf.length;if(size<=8192)out+=buf.toString("utf8");else child.kill("SIGKILL");});
    child.stderr.on("data",(buf:Buffer)=>{size+=buf.length;if(size>8192)child.kill("SIGKILL");});
    child.once("error",()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(new Error("Git unavailable"));});
    child.once("close",code=>{
      clearTimeout(timer);signal.removeEventListener("abort",abort);
      if(code!==0||size>8192||signal.aborted)reject(new Error("Trusted Git fetch failed"));
      else resolve(out.trim());
    });
  });
}
async function validatePublishedRelease(job:SourceBuildClaim,signal:AbortSignal):Promise<void>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15_000);timer.unref();
  const abort=()=>controller.abort();
  signal.addEventListener("abort",abort,{once:true});
  try{
    const response=await fetch(
      "https://api.github.com/repos/yohn-jp/scriptorium/releases/"+job.github_release_id,
      {headers:{Accept:"application/vnd.github+json","User-Agent":"praetorium-source-builder"},
       signal:controller.signal,redirect:"error"},
    );
    if(!response.ok)throw new Error("GitHub Release publication unavailable");
    const body:unknown=await response.json();
    const record=typeof body==="object"&&body!==null?body as Record<string,unknown>:{};
    if(record.id!==job.github_release_id||record.tag_name!==job.source_tag||
       record.draft!==false||typeof record.published_at!=="string")
      throw new Error("Selected GitHub Release is no longer published");
  }finally{clearTimeout(timer);signal.removeEventListener("abort",abort);}
}
async function checkout(job:SourceBuildClaim,folder:string,signal:AbortSignal):Promise<void>{
  await git(["init","--quiet",folder],folder,signal);
  await git(["remote","add","origin",REPO],folder,signal);
  await git(["fetch","--no-tags","--depth=1","origin","refs/tags/"+job.source_tag],folder,signal);
  const revision=await git(["rev-parse","FETCH_HEAD^{commit}"],folder,signal);
  if(revision!==job.source_revision)throw new Error("Source Release tag changed after selection");
  await git(["checkout","--quiet","--detach",revision],folder,signal);
  if((await git(["rev-parse","HEAD"],folder,signal))!==job.source_revision ||
     await git(["status","--porcelain"],folder,signal)!=="")
    throw new Error("Git checkout did not match committed source");
}
async function metadataDigest(filename:string):Promise<string>{
  const info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.size<=0||info.size>16384)
    throw new Error("Invalid BuildKit metadata");
  const raw:unknown=JSON.parse(await readFile(filename,"utf8"));
  const digest=typeof raw==="object"&&raw!==null&&"containerimage.digest" in raw
    ? (raw as Record<string,unknown>)["containerimage.digest"] : null;
  if(typeof digest!=="string"||!DIGEST.test(digest))throw new Error("BuildKit digest missing");
  return digest;
}
function buildctlPrefix(config:BuildWorkerConfig):string[]{
  return [
    "--addr",config.buildKit.address,
    "--tlsservername",config.buildKit.tlsServerName,
    "--tlscacert",config.buildKit.tlsCaFile,
    "--tlscert",config.buildKit.tlsCertFile,
    "--tlskey",config.buildKit.tlsKeyFile,
    "build","--progress=rawjson","--frontend","dockerfile.v0",
  ];
}
async function runBuild(
  config:BuildWorkerConfig,args:string[],cwd:string,temp:string,signal:AbortSignal,
):Promise<void>{
  const run=createBuildctlRunner(config.buildKit);
  await run([...buildctlPrefix(config),...args],{
    cwd,dockerConfigDirectory:config.buildKit.dockerConfigDirectory,
    temporaryDirectory:temp,safePath:config.buildKit.safePath,
    buildTimeoutMs:config.buildKit.buildTimeoutMs,
    maxProgressBytes:config.buildKit.maxProgressBytes,
    signal,onProgress:()=>undefined,
  });
}
const wrapper = `
FROM source AS praetorium-producer-metadata
ARG SCRIPTORIUM_PRODUCER_REVISION
ARG RUNTIME_BASE_DIGEST
ARG BUILD_KIT_DIGEST
RUN pnpm build
RUN mkdir -p /tmp/praetorium-source-proof \\
 && node scripts/hosted-build.mjs catalog \\
    --producer-revision "$SCRIPTORIUM_PRODUCER_REVISION" \\
    --runtime-base-digest "$RUNTIME_BASE_DIGEST" \\
    --build-kit-digest "$BUILD_KIT_DIGEST" \\
    --out /tmp/praetorium-source-proof/build-catalog.json
RUN node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {metadataForRuntime} from "./packages/api/dist/platform-runtime.js"; writeFileSync("/tmp/praetorium-source-proof/runtime-metadata.json", JSON.stringify(metadataForRuntime({producerRevision:process.env.SCRIPTORIUM_PRODUCER_REVISION,port:3000,shutdownTimeoutSeconds:25})));'
FROM scratch AS praetorium-source-output
COPY --from=praetorium-producer-metadata /tmp/praetorium-source-proof/ /
`;
async function signSource(
  config:BuildWorkerConfig,value:unknown,
):Promise<{algorithm:"Ed25519";keyId:string;signature:string}>{
  const info=await lstat(config.signingKeyFile);
  if(!info.isFile()||info.isSymbolicLink()||info.size>16384||
    (info.mode&0o077)!==0||(typeof process.getuid==="function" && info.uid!==process.getuid()))
    throw new Error("Worker signing key cannot be used");
  const key=createPrivateKey(await readFile(config.signingKeyFile));
  if(key.asymmetricKeyType!=="ed25519")throw new Error("Wrong Builder signing key type");
  return {algorithm:"Ed25519",keyId:config.signingKeyId,
    signature:edSign(null,Buffer.from(canonicalSourceProof(value),"utf8"),key).toString("base64")};
}

export async function buildSourceRelease(
  job:SourceBuildClaim,config:BuildWorkerConfig,signal:AbortSignal,
):Promise<SourceProducerResult>{
  assertClaim(job);
  const root=await mkdtemp(path.join(config.buildKit.temporaryDirectory,"source-producer-"));
  const source=path.join(root,"source");
  const dockerfiles=path.join(root,"dockerfile");
  const metadata=path.join(root,"metadata");
  try{
    await mkdir(source);
    await mkdir(dockerfiles);
    await mkdir(metadata);
    await validatePublishedRelease(job,signal);
    await checkout(job,source,signal);
    const dockerfile=await readFile(path.join(source,"Dockerfile"));
    if(dockerfile.length>128*1024)throw new Error("Source Dockerfile exceeds bound");
    const dockerfileDigest=createHash("sha256").update(dockerfile).digest("hex");
    // The Dockerfile is kept inside the remote BuildKit execution boundary;
    // the Worker never loads or executes producer Node packages locally.
    const args=[
      "--local","context="+source,"--local","dockerfile="+source,
      "--opt","platform=linux/amd64",
      "--opt","build-arg:SCRIPTORIUM_PRODUCER_REVISION="+job.source_revision,
    ];
    const runtimeMetadata=path.join(root,"runtime-base.json");
    await runBuild(config,[...args,"--opt","target=runtime-base",
      "--output","type=image,name="+IMAGE+":runtime-base-"+job.source_revision+",push=true",
      "--metadata-file",runtimeMetadata],source,root,signal);
    const runtimeDigest=await metadataDigest(runtimeMetadata);
    const kitMetadata=path.join(root,"build-kit.json");
    await runBuild(config,[...args,"--opt","target=buildkit",
      "--opt","build-arg:SCRIPTORIUM_DOCKERFILE_SHA256="+dockerfileDigest,
      "--output","type=image,name="+IMAGE+":build-kit-"+job.source_revision+",push=true",
      "--metadata-file",kitMetadata],source,root,signal);
    const buildKitDigest=await metadataDigest(kitMetadata);
    await writeFile(path.join(dockerfiles,"Dockerfile"),
      Buffer.concat([dockerfile,Buffer.from("\n"+wrapper,"utf8")]),{mode:0o600});
    await runBuild(config,[
      "--local","context="+source,"--local","dockerfile="+dockerfiles,
      "--opt","platform=linux/amd64","--opt","target=praetorium-source-output",
      "--opt","build-arg:SCRIPTORIUM_PRODUCER_REVISION="+job.source_revision,
      "--opt","build-arg:RUNTIME_BASE_DIGEST="+runtimeDigest,
      "--opt","build-arg:BUILD_KIT_DIGEST="+buildKitDigest,
      "--output","type=local,dest="+metadata,
    ],source,root,signal);
    const catalog=BuildCatalogSchema.parse(
      JSON.parse(await readFile(path.join(metadata,"build-catalog.json"),"utf8")));
    const runtime=RuntimeMetadataSchema.parse(
      JSON.parse(await readFile(path.join(metadata,"runtime-metadata.json"),"utf8")));
    if(catalog.producerRevision!==job.source_revision ||
      runtime.producerRevision!==job.source_revision ||
      catalog.runtimeBaseDigest!==runtimeDigest ||
      catalog.buildKitDigest!==buildKitDigest)
      throw new Error("Producer catalog does not bind exact BuildKit outputs");
    const statement={
      schemaVersion:1 as const,jobId:job.job_id,githubReleaseId:job.github_release_id,
      sourceId:"scriptorium" as const,sourceRepository:"yohn-jp/scriptorium" as const,
      sourceTag:job.source_tag,sourceRevision:job.source_revision,
      releaseVersion:job.release_version,
      imageRepository:IMAGE as "ghcr.io/yohn-jp/praetorium/scriptorium-producer",
      runtimeBaseDigest:runtimeDigest,buildKitDigest,
      catalogDigest:await sourceProofDigest(catalog),
      runtimeMetadataDigest:await sourceProofDigest(runtime),
    };
    return SourceProducerResultSchema.parse({
      statement,signature:await signSource(config,statement),
      catalog,runtimeMetadata:runtime,
    });
  }finally{await rm(root,{recursive:true,force:true,maxRetries:2,retryDelay:100});}
}
