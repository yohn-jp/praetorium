import { spawn } from "node:child_process";
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, rm, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { createBuildctlRunner } from "@praetorium/buildkit";
import {
  BuildCatalogSchema, RuntimeMetadataSchema, SourceProducerResultSchemaV2,
  SOURCE_PRODUCER_RESULT_MAX_BYTES, canonicalSourceProof, repositoryPathForHost,
  sourceProducerResultByteLength, sourceProofDigest, type SourceProducerResult,
} from "@praetorium/contracts";
import type { BuildWorkerConfig } from "./config.js";

const REPO="https://github.com/yohn-jp/scriptorium.git";
const GHCR_REPOSITORY=/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const SHA=/^[a-f0-9]{40}$/u;
const TAG=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DIGEST=/^sha256:[a-f0-9]{64}$/u;
const MAX_RESOLVER_BYTES=4*1024*1024;
const TRUSTED_GIT_PATH="/usr/local/bin:/usr/bin:/bin";
const MAX_CATALOG_BYTES=4*1024*1024;
const SCRIPTORIUM_V021_REVISION="3189a85bfa28ddd160600a0188ab3ccfa91755e4";
const SCRIPTORIUM_V021_DOCKERFILE_SHA256="005b540188d5337e103bb4e5aba17c0ae4be3439c17d02b170a6b3d9a28ce350";
const NODE_PUBLIC_CA_BOOTSTRAP="RUN node --input-type=module -e 'import{rootCertificates}from\"node:tls\";import{mkdirSync,writeFileSync}from\"node:fs\";mkdirSync(\"/etc/ssl/certs\",{recursive:true});writeFileSync(\"/etc/ssl/certs/ca-certificates.crt\",rootCertificates.join(\"\\n\")+\"\\n\")'";
const DEBIAN_HTTPS_SOURCES=String.raw`RUN test -f /etc/apt/sources.list.d/debian.sources \
 && sed -i \
    -e 's|^URIs: http://deb.debian.org/debian$|URIs: https://deb.debian.org/debian|' \
    -e 's|^URIs: http://deb.debian.org/debian-security$|URIs: https://deb.debian.org/debian-security|' \
    /etc/apt/sources.list.d/debian.sources \
 && grep -Fqx 'URIs: https://deb.debian.org/debian' /etc/apt/sources.list.d/debian.sources \
 && grep -Fqx 'URIs: https://deb.debian.org/debian-security' /etc/apt/sources.list.d/debian.sources`;

export interface SourceBuildClaim {
  job_id:string; source_id:"scriptorium"; source_repository:"yohn-jp/scriptorium";
  github_release_id:number; source_tag:string;source_revision:string;
  release_version:string; actor_id:string;
  lease_worker:string;lease_token:string;lease_epoch:number;lease_expires_at:number;
}

/** Test-only physical destination for the two immutable BuildKit outputs.
 * The signed Source proof always keeps the production GHCR identity. */
export interface IsolatedSourceBuildRegistry {
  readonly host:string;
  readonly repositoryPath:string;
}
export interface SourceBuildOptions {
  readonly isolatedRegistry?:IsolatedSourceBuildRegistry;
}

/** A published Release or immutable source binding no longer matches the
 * queued claim. Callers may terminalize this failure without spending retries. */
export class SourceBuildChangedError extends Error {
  readonly code="SOURCE_CHANGED" as const;
  constructor(){super("SOURCE_CHANGED");this.name="SourceBuildChangedError";}
}

/** Source outputs are permanent evidence failures once the BuildKit solve has succeeded. */
export class SourceBuildVerificationError extends Error {
  readonly code="SOURCE_VERIFICATION_FAILED" as const;
  constructor(){super("SOURCE_VERIFICATION_FAILED");this.name="SourceBuildVerificationError";}
}

export function assertSourceProducerResultWithinBudget(value:unknown):void{
  let byteLength:number;
  try{byteLength=sourceProducerResultByteLength(value);}
  catch{throw new SourceBuildVerificationError();}
  if(byteLength>SOURCE_PRODUCER_RESULT_MAX_BYTES)throw new SourceBuildVerificationError();
}

function replaceDockerfileAnchor(source:string,anchor:string,replacement:string):string{
  const first=source.indexOf(anchor);
  if(first<0||source.indexOf(anchor,first+anchor.length)>=0)
    throw new SourceBuildVerificationError();
  return source.slice(0,first)+replacement+source.slice(first+anchor.length);
}

/** Apply the platform-owned network foundation only to the byte-pinned
 * Scriptorium v0.2.1 Dockerfile. The original bytes and digest remain the
 * source provenance identity; this adapted copy is only a BuildKit frontend
 * input. */
export function adaptScriptoriumV021Dockerfile(revision:string,original:Buffer):Buffer{
  if(revision!==SCRIPTORIUM_V021_REVISION||
     createHash("sha256").update(original).digest("hex")!==SCRIPTORIUM_V021_DOCKERFILE_SHA256)
    throw new SourceBuildVerificationError();
  let adapted=original.toString("utf8");
  const pnpmAnchor=`FROM \${NODE_IMAGE} AS pnpm-base\nARG PNPM_VERSION\nENV CI=true\n`;
  adapted=replaceDockerfileAnchor(adapted,pnpmAnchor,
    pnpmAnchor+NODE_PUBLIC_CA_BOOTSTRAP+"\n");
  const corepackAnchor=[
    "RUN corepack enable \\",
    " && corepack prepare pnpm@${PNPM_VERSION} --activate",
  ].join("\n");
  const corepackReplacement=[
    "RUN export NODE_USE_ENV_PROXY=1 NODE_USE_SYSTEM_CA=1 \\",
    " && corepack enable \\",
    " && corepack prepare pnpm@${PNPM_VERSION} --activate",
  ].join("\n");
  adapted=replaceDockerfileAnchor(adapted,corepackAnchor,corepackReplacement);
  adapted=replaceDockerfileAnchor(adapted,"RUN pnpm install --frozen-lockfile",
    "RUN NODE_USE_ENV_PROXY=1 NODE_USE_SYSTEM_CA=1 pnpm install --frozen-lockfile");
  const runtimeBaseAnchor=`FROM \${NODE_IMAGE} AS runtime-base\nARG SCRIPTORIUM_PRODUCER_REVISION\n`;
  adapted=replaceDockerfileAnchor(adapted,runtimeBaseAnchor,
    runtimeBaseAnchor+NODE_PUBLIC_CA_BOOTSTRAP+"\n"+DEBIAN_HTTPS_SOURCES+"\n");
  const runtimeAnchor=`FROM \${NODE_IMAGE} AS runtime\nARG PROFILE\n`;
  adapted=replaceDockerfileAnchor(adapted,runtimeAnchor,
    runtimeAnchor+NODE_PUBLIC_CA_BOOTSTRAP+"\n"+DEBIAN_HTTPS_SOURCES+"\n");
  return Buffer.from(adapted,"utf8");
}

/** The provenance build consumes only a fresh, verified Git checkout. Give
 * its separate metadata Dockerfile the complete checkout, including tracked
 * files ignored by Scriptorium's production image context rules. */
export function sourceMetadataDockerfileIgnore():Buffer{
  return Buffer.alloc(0);
}

function outputRepository(options:SourceBuildOptions,logicalRepository:string):string{
  const target=options.isolatedRegistry;
  if(!target)return logicalRepository;
  if(process.env.NODE_ENV!=="test"||
     !/^127\.0\.0\.1:(?:[1-9]\d{0,4})$/u.test(target.host)||
     Number(target.host.slice(target.host.indexOf(":")+1))>65535||
     !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(target.repositoryPath))
    throw new TypeError("Isolated source registry is available only to loopback tests");
  return target.host+"/"+target.repositoryPath;
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

/** Git must not interpret tracked files as the host user's global configuration. */
export function sourceGitEnvironment(privateHome:string,pathValue=TRUSTED_GIT_PATH):NodeJS.ProcessEnv{
  if(!path.isAbsolute(privateHome)||privateHome.includes("\0")||!pathValue)
    throw new TypeError("Trusted Git environment is invalid");
  const emptyConfig=process.platform==="win32"?"NUL":"/dev/null";
  return {
    PATH:pathValue,HOME:privateHome,USERPROFILE:privateHome,
    XDG_CONFIG_HOME:privateHome,LANG:"C",GIT_CONFIG_NOSYSTEM:"1",
    GIT_CONFIG_GLOBAL:emptyConfig,GIT_TERMINAL_PROMPT:"0",
    GIT_CONFIG_COUNT:"3",
    GIT_CONFIG_KEY_0:"core.hooksPath",GIT_CONFIG_VALUE_0:emptyConfig,
    GIT_CONFIG_KEY_1:"protocol.file.allow",GIT_CONFIG_VALUE_1:"never",
    GIT_CONFIG_KEY_2:"core.fsmonitor",GIT_CONFIG_VALUE_2:"false",
  };
}

async function git(args:readonly string[],cwd:string,privateHome:string,signal:AbortSignal):Promise<string>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error("Canceled"));return;}
    const child=spawn("git",args,{
      cwd, shell:false,windowsHide:true,
      env:sourceGitEnvironment(privateHome),
      stdio:["ignore","pipe","pipe"],
    });
    let out="",size=0;
    const timer=setTimeout(()=>child.kill("SIGKILL"),60_000);timer.unref();
    const abort=()=>child.kill("SIGKILL");
    signal.addEventListener("abort",abort,{once:true});
    child.stdout.on("data",(buf:Buffer)=>{size+=buf.length;if(size<=8192)out+=buf.toString("utf8");else child.kill("SIGKILL");});
    child.stderr.on("data",(buf:Buffer)=>{size+=buf.length;if(size>8192)child.kill("SIGKILL");});
    child.once("error",()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(new Error("Git "+args[0]+" executable unavailable"));});
    child.once("close",code=>{
      clearTimeout(timer);signal.removeEventListener("abort",abort);
      if(code!==0||size>8192||signal.aborted)reject(new Error("Trusted Git "+args[0]+" failed (exit "+String(code)+")"));
      else resolve(out.trim());
    });
  });
}

/** Read a bounded regular file without following producer-controlled symlinks.
 * BuildKit's local exporter returns untrusted entries, so lstat + readFile is
 * not enough: an attacker could replace an output with a link between calls. */
export async function readSourceProducerFile(
  filename:string,maximumBytes:number,label="producer artifact",allowEmpty=false,
):Promise<Buffer>{
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1)
    throw new TypeError("Invalid producer artifact bound");
  const leaf=path.basename(filename);
  if(!leaf||leaf==="."||leaf==="..")throw new Error("Invalid "+label);
  const parent=await open(path.dirname(filename),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
    const parentInfo=await parent.stat();
    if(!parentInfo.isDirectory())throw new Error("Invalid "+label+" directory");
    // Pin the parent directory while opening the leaf. BuildKit can export a
    // symlink as an intermediate directory (for example `resolver/`), so a
    // leaf-only O_NOFOLLOW check does not prevent reading outside the output.
    const handle=await open(`/proc/self/fd/${parent.fd}/${leaf}`,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const info=await handle.stat();
      if(!info.isFile()||(!allowEmpty&&info.size<=0)||info.size>maximumBytes)
        throw new Error("Invalid "+label);
      const bytes=await handle.readFile();
      if(bytes.length!==info.size||bytes.length>maximumBytes||(!allowEmpty&&bytes.length===0))
        throw new Error("Invalid "+label);
      return bytes;
    }finally{await handle.close();}
  }finally{await parent.close();}
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
    if(!response.ok){
      if(response.status===404)throw new SourceBuildChangedError();
      throw new Error("GitHub Release publication unavailable (HTTP "+response.status+")");
    }
    const body:unknown=await response.json();
    const record=typeof body==="object"&&body!==null?body as Record<string,unknown>:{};
    if(record.id!==job.github_release_id||record.tag_name!==job.source_tag||
       record.draft!==false||typeof record.published_at!=="string")
      throw new SourceBuildChangedError();
  }finally{clearTimeout(timer);signal.removeEventListener("abort",abort);}
}
async function checkout(job:SourceBuildClaim,folder:string,privateHome:string,signal:AbortSignal):Promise<void>{
  await git(["init","--quiet",folder],folder,privateHome,signal);
  await git(["remote","add","origin",REPO],folder,privateHome,signal);
  await git(["fetch","--no-tags","--depth=1","origin","refs/tags/"+job.source_tag],folder,privateHome,signal);
  const revision=await git(["rev-parse","FETCH_HEAD^{commit}"],folder,privateHome,signal);
  if(revision!==job.source_revision)throw new SourceBuildChangedError();
  await git(["checkout","--quiet","--detach",revision],folder,privateHome,signal);
  if((await git(["rev-parse","HEAD"],folder,privateHome,signal))!==job.source_revision ||
     await git(["status","--porcelain"],folder,privateHome,signal)!=="")
    throw new SourceBuildChangedError();
}
async function metadataDigest(filename:string):Promise<string>{
  try{
    const bytes=await readSourceProducerFile(filename,16384,"BuildKit metadata");
    const raw:unknown=JSON.parse(bytes.toString("utf8"));
    const digest=typeof raw==="object"&&raw!==null&&"containerimage.digest" in raw
      ? (raw as Record<string,unknown>)["containerimage.digest"] : null;
    if(typeof digest!=="string"||!DIGEST.test(digest))throw new Error("BuildKit digest missing");
    return digest;
  }catch{throw new SourceBuildVerificationError();}
}
async function resolverArtifact(folder:string):Promise<{
  readonly digest:`sha256:${string}`;readonly provenance:Record<string,unknown>;
  readonly provenanceDigest:`sha256:${string}`;
}>{
  try{
    const bundlePath=path.join(folder,"build-catalog.mjs");
    const provenancePath=path.join(folder,"provenance.json");
    const [bundle,provenanceBytes]=await Promise.all([
      readSourceProducerFile(bundlePath,MAX_RESOLVER_BYTES,"producer resolver bundle"),
      readSourceProducerFile(provenancePath,64*1024,"producer resolver provenance"),
    ]);
    const provenance:unknown=JSON.parse(provenanceBytes.toString("utf8"));
    if(typeof provenance!=="object"||provenance===null||Array.isArray(provenance))
      throw new Error("Invalid producer resolver provenance");
    const record=provenance as Record<string,unknown>;
    const digest=`sha256:${createHash("sha256").update(bundle).digest("hex")}` as const;
    if(record.schemaVersion!=="scriptorium-build-catalog-resolver-provenance/v1"||
       record.sourceTreeClean!==true||record.bundlePath!=="build-catalog.mjs"||
       record.bundleDigest!==digest)
      throw new Error("Producer resolver provenance does not match its bundle");
    return {digest,provenance:record,provenanceDigest:await sourceProofDigest(record)};
  }catch{throw new SourceBuildVerificationError();}
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
${NODE_PUBLIC_CA_BOOTSTRAP}
${DEBIAN_HTTPS_SOURCES}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates git \\
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /tmp/praetorium-source-proof \\
 && node scripts/build-catalog-bundle.mjs --out-dir /tmp/praetorium-source-proof/resolver \\
 && node scripts/hosted-build.mjs catalog \\
    --producer-revision "$SCRIPTORIUM_PRODUCER_REVISION" \\
    --runtime-base-digest "$RUNTIME_BASE_DIGEST" \\
    --build-kit-digest "$BUILD_KIT_DIGEST" \\
    --out /tmp/praetorium-source-proof/build-catalog.json \\
 && node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {metadataForRuntime} from "./packages/api/dist/platform-runtime.js"; writeFileSync("/tmp/praetorium-source-proof/runtime-metadata.json", JSON.stringify(metadataForRuntime({producerRevision:process.env.SCRIPTORIUM_PRODUCER_REVISION,port:3000,shutdownTimeoutSeconds:25})));'
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
  const keyBytes=await readSourceProducerFile(config.signingKeyFile,16384,"Worker signing key");
  const key=createPrivateKey(keyBytes);
  if(key.asymmetricKeyType!=="ed25519")throw new Error("Wrong Builder signing key type");
  return {algorithm:"Ed25519",keyId:config.signingKeyId,
    signature:edSign(null,Buffer.from(canonicalSourceProof(value),"utf8"),key).toString("base64")};
}

export async function buildSourceRelease(
  job:SourceBuildClaim,config:BuildWorkerConfig,signal:AbortSignal,options:SourceBuildOptions={},
):Promise<SourceProducerResult>{
  assertClaim(job);
  const imageRepository=config.buildKit.buildkitRepository;
  if(!GHCR_REPOSITORY.test(imageRepository))
    throw new TypeError("Configured Producer repository is not an approved GHCR repository");
  repositoryPathForHost(imageRepository,"ghcr.io");
  const outputImage=outputRepository(options,imageRepository);
  const root=await mkdtemp(path.join(config.buildKit.temporaryDirectory,"source-producer-"));
  const source=path.join(root,"source");
  const dockerfiles=path.join(root,"dockerfile-source");
  const metadataDockerfiles=path.join(root,"dockerfile-metadata");
  const metadata=path.join(root,"metadata");
  const privateGitHome=path.join(root,"git-home");
  try{
    await mkdir(source);
    await mkdir(dockerfiles);
    await mkdir(metadataDockerfiles);
    await mkdir(metadata);
    await mkdir(privateGitHome,{mode:0o700});
    await validatePublishedRelease(job,signal);
    await checkout(job,source,privateGitHome,signal);
    const dockerfile=await readSourceProducerFile(path.join(source,"Dockerfile"),128*1024,"Source Dockerfile");
    const dockerfileDigest=createHash("sha256").update(dockerfile).digest("hex");
    const buildDockerfile=adaptScriptoriumV021Dockerfile(job.source_revision,dockerfile);
    const ignoreBytes=await readSourceProducerFile(path.join(source,".dockerignore"),64*1024,"Source Docker ignore file",true);
    await writeFile(path.join(dockerfiles,"Dockerfile"),buildDockerfile,{mode:0o600});
    await writeFile(path.join(dockerfiles,"Dockerfile.dockerignore"),ignoreBytes,{mode:0o600});
    // The Dockerfile is kept inside the remote BuildKit execution boundary;
    // the Worker never loads or executes producer Node packages locally.
    const args=[
      "--local","context="+source,"--local","dockerfile="+dockerfiles,
      "--opt","platform=linux/amd64",
      "--opt","build-arg:SCRIPTORIUM_PRODUCER_REVISION="+job.source_revision,
    ];
    const runtimeMetadata=path.join(root,"runtime-base.json");
    await runBuild(config,[...args,"--opt","target=runtime-base",
      "--output","type=image,name="+outputImage+":runtime-base-"+job.source_revision+",push=true",
      "--metadata-file",runtimeMetadata],source,root,signal);
    const runtimeDigest=await metadataDigest(runtimeMetadata);
    const kitMetadata=path.join(root,"build-kit.json");
    await runBuild(config,[...args,"--opt","target=buildkit",
      "--opt","build-arg:SCRIPTORIUM_DOCKERFILE_SHA256="+dockerfileDigest,
      "--output","type=image,name="+outputImage+":build-kit-"+job.source_revision+",push=true",
      "--metadata-file",kitMetadata],source,root,signal);
    const buildKitDigest=await metadataDigest(kitMetadata);
    await writeFile(path.join(metadataDockerfiles,"Dockerfile"),
      Buffer.concat([buildDockerfile,Buffer.from("\n"+wrapper,"utf8")]),{mode:0o600});
    await writeFile(path.join(metadataDockerfiles,"Dockerfile.dockerignore"),
      sourceMetadataDockerfileIgnore(),{mode:0o600});
    await runBuild(config,[
      "--local","context="+source,"--local","dockerfile="+metadataDockerfiles,
      "--opt","platform=linux/amd64","--opt","target=praetorium-source-output",
      "--opt","build-arg:SCRIPTORIUM_PRODUCER_REVISION="+job.source_revision,
      "--opt","build-arg:RUNTIME_BASE_DIGEST="+runtimeDigest,
      "--opt","build-arg:BUILD_KIT_DIGEST="+buildKitDigest,
      "--output","type=local,dest="+metadata,
    ],source,root,signal);
    let catalogBytes:Buffer;
    let runtimeBytes:Buffer;
    try{
      [catalogBytes,runtimeBytes]=await Promise.all([
        readSourceProducerFile(path.join(metadata,"build-catalog.json"),MAX_CATALOG_BYTES,"BuildKit catalog"),
        readSourceProducerFile(path.join(metadata,"runtime-metadata.json"),16*1024,"BuildKit runtime metadata"),
      ]);
    }catch{throw new SourceBuildVerificationError();}
    let catalog:ReturnType<typeof BuildCatalogSchema.parse>;
    let runtime:ReturnType<typeof RuntimeMetadataSchema.parse>;
    try{
      catalog=BuildCatalogSchema.parse(JSON.parse(catalogBytes.toString("utf8")));
      runtime=RuntimeMetadataSchema.parse(JSON.parse(runtimeBytes.toString("utf8")));
    }catch{throw new SourceBuildVerificationError();}
    const resolver=await resolverArtifact(path.join(metadata,"resolver"));
    if(catalog.producerRevision!==job.source_revision ||
      runtime.producerRevision!==job.source_revision ||
      catalog.runtimeBaseDigest!==runtimeDigest ||
      catalog.buildKitDigest!==buildKitDigest ||
      resolver.provenance.producerRevision!==job.source_revision)
      throw new SourceBuildVerificationError();
    const statement={
      schemaVersion:2 as const,jobId:job.job_id,githubReleaseId:job.github_release_id,
      sourceId:"scriptorium" as const,sourceRepository:"yohn-jp/scriptorium" as const,
      sourceTag:job.source_tag,sourceRevision:job.source_revision,
      releaseVersion:job.release_version,
      imageRepository,
      runtimeBaseDigest:runtimeDigest,buildKitDigest,
      catalogDigest:await sourceProofDigest(catalog),
      runtimeMetadataDigest:await sourceProofDigest(runtime),
      resolverDigest:resolver.digest,
    };
    let unsigned:SourceProducerResult;
    try{
      unsigned=SourceProducerResultSchemaV2.parse({
        statement,
        signature:{algorithm:"Ed25519",keyId:config.signingKeyId,signature:"A".repeat(88)},
        catalog,runtimeMetadata:runtime,
        resolver:{
          producerRevision:job.source_revision,
          resolverRevision:resolver.digest,
          contractVersion:catalog.contractVersion,
          provenanceDigest:resolver.provenanceDigest,
        },
      });
    }catch{throw new SourceBuildVerificationError();}
    assertSourceProducerResultWithinBudget(unsigned);
    return SourceProducerResultSchemaV2.parse({
      ...unsigned,
      signature:await signSource(config,statement),
    });
  }finally{await rm(root,{recursive:true,force:true,maxRetries:2,retryDelay:100});}
}
