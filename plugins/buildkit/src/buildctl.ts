import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { BuildProgress } from "@praetorium/application/builds";
import { sanitizeSourceDiagnostic } from "@praetorium/contracts";
import {
  BuildKitAttemptError,
  type BuildKitDiagnosticExcerpt,
  type BuildKitProviderConfig,
} from "./types.js";

const MAX_DIAGNOSTIC_RAW_BYTES = 8 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const MAX_DIAGNOSTIC_LINES = 16;

export type BuildctlRunOptions = {
  cwd: string;
  dockerConfigDirectory: string;
  temporaryDirectory: string;
  safePath: string;
  buildTimeoutMs: number;
  maxProgressBytes: number;
  signal: AbortSignal;
  onProgress: (progress: BuildProgress) => void;
};

export type BuildctlRunner = (
  args: readonly string[],
  options: BuildctlRunOptions,
) => Promise<void>;

type RawVertex = {
  digest?: string;
  completed?: string | number | null;
  cached?: boolean;
  error?: string;
};

type RawLog = { vertex?: string; stream?: number; data?: string };
type RawProgress = { vertexes?: RawVertex[]; logs?: RawLog[]; error?: string };

type ParsedProgressLine = {
  readonly value: RawProgress;
  readonly progress: BuildProgress | null;
};

function parseProgressLine(line: string): ParsedProgressLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const vertexes = Array.isArray(record.vertexes)
    ? record.vertexes.filter(isRawVertex)
    : undefined;
  const logs = Array.isArray(record.logs) ? record.logs.filter(isRawLog) : undefined;
  const value: RawProgress = {
    ...(vertexes ? { vertexes } : {}),
    ...(logs ? { logs } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
  if (!vertexes || vertexes.length === 0) return { value, progress: null };
  let completed = 0;
  for (const item of vertexes) {
    if (
      item &&
      (typeof item.completed === "string" ||
        typeof item.completed === "number" ||
        item.cached === true)
    ) {
      completed++;
    }
  }
  return {
    value,
    progress: {
      stage: "building",
      percent: Math.max(0, Math.min(99, Math.floor((completed / vertexes.length) * 100))),
    },
  };
}

function isRawVertex(value: unknown): value is RawVertex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.digest === undefined ||
      (typeof record.digest === "string" && record.digest.length <= 256)) &&
    (record.error === undefined || typeof record.error === "string") &&
    (record.cached === undefined || typeof record.cached === "boolean") &&
    (record.completed === undefined ||
      record.completed === null ||
      typeof record.completed === "string" ||
      typeof record.completed === "number")
  );
}

function isRawLog(value: unknown): value is RawLog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.vertex === undefined ||
      (typeof record.vertex === "string" && record.vertex.length <= 256)) &&
    (record.stream === undefined || typeof record.stream === "number") &&
    (record.data === undefined || typeof record.data === "string")
  );
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) return { value: result, truncated: true };
    result += character;
    bytes += characterBytes;
  }
  return { value: result, truncated: false };
}

function stripControlCharacters(value:string):string{
  return [...value].filter((character)=>{
    const code=character.charCodeAt(0);
    return code>=32&&code!==127;
  }).join("");
}

const COMMAND_LINE = /^\s*(?:(?:#\d+\s+)?(?:RUN|CMD|ENTRYPOINT)\b|(?:\/bin\/(?:ba|z|a)?sh\s+-c\b)|\$\s|(?:export|env|printenv|set)\b)/iu;
const EMBEDDED_COMMAND = /(?:\/bin\/(?:ba|z|a)?sh\s+-c\b|\bprocess\s+["'].*\s+-c\s)/iu;
const HEADER_LINE = /^\s*(?:authorization|proxy-authorization|cookie|set-cookie|www-authenticate|x-[a-z0-9-]*(?:token|secret|key|auth))\s*:/iu;
const ENV_ASSIGNMENT_LINE = /^\s*[A-Za-z_][A-Za-z0-9_]{1,63}\s*=/u;
const PRIVATE_KEY_LINE = /^\s*-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\s*$/u;
const PRIVATE_KEY_END_LINE = /^\s*-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/u;

/** Keep useful diagnostics while treating all producer output as untrusted. */
export function sanitizeBuildKitDiagnostic(
  input: string,
  maximumBytes = MAX_DIAGNOSTIC_BYTES,
): BuildKitDiagnosticExcerpt | undefined {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("BuildKit diagnostic byte limit is invalid");
  }
  const normalized = input.replace(/\r\n?/gu, "\n");
  const lines: string[] = [];
  let inPrivateKey = false;
  let filtered = false;
  for (const sourceLine of normalized.split("\n")) {
    const line = stripControlCharacters(sourceLine).trim();
    if (inPrivateKey) {
      filtered = true;
      if (PRIVATE_KEY_END_LINE.test(line)) inPrivateKey = false;
      continue;
    }
    if (PRIVATE_KEY_LINE.test(line)) {
      filtered = true;
      inPrivateKey = true;
      continue;
    }
    if (!line || COMMAND_LINE.test(line) || EMBEDDED_COMMAND.test(line) || HEADER_LINE.test(line) || ENV_ASSIGNMENT_LINE.test(line)) {
      if (line) filtered = true;
      continue;
    }

    const sanitized = line
      .replace(/\b(?:https?|ftp):\/\/[^\s"'<>]+/giu, "[url redacted]")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/giu, "$1 [redacted]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/gu, "[token redacted]")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{12,}|npm_[A-Za-z0-9]{12,})\b/gu, "[token redacted]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[key redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[token redacted]")
      .replace(/\b([A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|AUTHORIZATION|CREDENTIAL)[A-Z0-9_-]*)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=[redacted]")
      .replace(/--(?:token|password|secret|auth)(?:=|\s+)\S+/giu, "[argument redacted]")
      .replace(/\b(?:\/run\/secrets|\/var\/run|\/tmp|\/root|\/home)\/[^\s"'<>:]*/gu, "[path redacted]")
      .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*$/giu, "[private key redacted]");
    if (sanitized !== line) filtered = true;
    const cleaned = stripControlCharacters(sanitized).trim();
    if (cleaned) lines.push(cleaned);
    if (lines.length >= MAX_DIAGNOSTIC_LINES) {
      filtered = true;
      break;
    }
  }
  if (inPrivateKey) filtered = true;
  if (lines.length === 0) return undefined;
  const bounded = truncateUtf8(lines.join("\n"), maximumBytes);
  if (!bounded.value.trim()) return undefined;
  const shared = sanitizeSourceDiagnostic({
    stage:"buildkit",reason:"build_failed",summary:"",excerpt:bounded.value,
    truncated:filtered||bounded.truncated,
  });
  if(!shared.excerpt)return undefined;
  const safeBounded=truncateUtf8(shared.excerpt,maximumBytes);
  if(!safeBounded.value.trim())return undefined;
  return {text:safeBounded.value,truncated:shared.truncated||safeBounded.truncated};
}

function decodeLog(data: string): string | undefined {
  if (!data || data.length > 16 * 1024 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data))
    return undefined;
  try {
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_DIAGNOSTIC_RAW_BYTES) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

class BuildKitDiagnosticCapture {
  private readonly logEntries: { vertex:string|null; text:string; bytes:number; sequence:number }[] = [];
  private readonly errorEntries: { vertex:string|null; text:string; bytes:number; sequence:number }[] = [];
  private readonly stderrEntries: { text:string; bytes:number; sequence:number }[] = [];
  private readonly pending = new Map<string,string>();
  private pendingBytes = 0;
  private diagnosticBytes = 0;
  private readonly privateKeyVertices = new Set<string>();
  private readonly failedVertices:string[]=[];
  private dropLogDiagnostics=false;
  private stderrPrivateKey=false;
  private truncated = false;
  private sequence = 0;

  private addSafeLog(vertex:string|null,text:string):void{
    if(this.dropLogDiagnostics)return;
    const normalized=text.trim();
    if(!normalized)return;
    const vertexKey=vertex??"";
    if(/-----BEGIN .*PRIVATE KEY-----/u.test(normalized)){
      this.truncated=true;
      if(!/-----END .*PRIVATE KEY-----/u.test(normalized)){
        if(this.privateKeyVertices.size>=MAX_DIAGNOSTIC_LINES){
          this.privateKeyVertices.clear();
          this.dropLogDiagnostics=true;
          return;
        }
        this.privateKeyVertices.add(vertexKey);
      }
      return;
    }
    if(this.privateKeyVertices.has(vertexKey)){
      this.truncated=true;
      if(/-----END .*PRIVATE KEY-----/u.test(normalized))this.privateKeyVertices.delete(vertexKey);
      return;
    }
    const safe=sanitizeBuildKitDiagnostic(normalized,MAX_DIAGNOSTIC_BYTES);
    if(!safe)return;
    const bytes=Buffer.byteLength(safe.text,"utf8");
    if(bytes===0)return;
    this.logEntries.push({vertex,text:safe.text,bytes,sequence:this.sequence++});
    this.diagnosticBytes+=bytes;
    this.truncated=this.truncated||safe.truncated;
    this.trimEntries();
  }

  private setPending(vertex:string,text:string):void{
    const prior=this.pending.get(vertex)??"";
    this.pendingBytes-=Buffer.byteLength(prior,"utf8");
    if(!text){this.pending.delete(vertex);return;}
    const bounded=truncateUtf8(text,MAX_DIAGNOSTIC_RAW_BYTES);
    this.pending.set(vertex,bounded.value);
    this.pendingBytes+=Buffer.byteLength(bounded.value,"utf8");
    if(bounded.truncated)this.truncated=true;
    while((this.pendingBytes>MAX_DIAGNOSTIC_RAW_BYTES||this.pending.size>MAX_DIAGNOSTIC_LINES)&&this.pending.size>0){
      const oldest=this.pending.keys().next().value as string|undefined;
      if(oldest===undefined)break;
      this.pendingBytes-=Buffer.byteLength(this.pending.get(oldest)??"","utf8");
      this.pending.delete(oldest);
      this.truncated=true;
    }
  }

  private addError(vertex:string|null,text:string):void{
    const safe=sanitizeBuildKitDiagnostic(text,MAX_DIAGNOSTIC_BYTES);
    if(!safe)return;
    const bytes=Buffer.byteLength(safe.text,"utf8");
    this.errorEntries.push({vertex,text:safe.text,bytes,sequence:this.sequence++});
    this.diagnosticBytes+=bytes;
    this.truncated=this.truncated||safe.truncated;
    this.trimEntries();
  }

  private addStderr(text:string):void{
    const normalized=text.trim();
    if(this.stderrPrivateKey){
      this.truncated=true;
      if(PRIVATE_KEY_END_LINE.test(normalized))this.stderrPrivateKey=false;
      return;
    }
    if(PRIVATE_KEY_LINE.test(normalized)){
      this.stderrPrivateKey=true;
      this.truncated=true;
      return;
    }
    const safe=sanitizeBuildKitDiagnostic(text,MAX_DIAGNOSTIC_BYTES);
    if(!safe)return;
    const bytes=Buffer.byteLength(safe.text,"utf8");
    this.stderrEntries.push({text:safe.text,bytes,sequence:this.sequence++});
    this.diagnosticBytes+=bytes;
    this.truncated=this.truncated||safe.truncated;
    this.trimEntries();
  }

  private trimEntries():void{
    const count=()=>this.logEntries.length+this.errorEntries.length+this.stderrEntries.length;
    while(this.diagnosticBytes>MAX_DIAGNOSTIC_RAW_BYTES||count()>MAX_DIAGNOSTIC_LINES){
      const log=this.logEntries[0];
      const error=this.errorEntries[0];
      const stderr=this.stderrEntries[0];
      const oldest=Math.min(log?.sequence??Infinity,error?.sequence??Infinity,stderr?.sequence??Infinity);
      let removedBytes:number;
      if(log&&log.sequence===oldest){this.logEntries.shift();removedBytes=log.bytes;}
      else if(error&&error.sequence===oldest){this.errorEntries.shift();removedBytes=error.bytes;}
      else if(stderr&&stderr.sequence===oldest){this.stderrEntries.shift();removedBytes=stderr.bytes;}
      else break;
      this.diagnosticBytes-=removedBytes;
      this.truncated=true;
    }
  }

  consume(value: RawProgress): void {
    if(typeof value.error==="string"&&value.error.trim())this.addError(null,value.error);
    for (const vertex of value.vertexes ?? []) {
      if (typeof vertex.error === "string" && vertex.error.trim()) {
        if(vertex.digest){
          this.failedVertices.push(vertex.digest);
          if(this.failedVertices.length>MAX_DIAGNOSTIC_LINES){
            this.failedVertices.shift();
            this.truncated=true;
          }
        }
        this.addError(vertex.digest??null,vertex.error);
      }
    }
    for(const log of value.logs??[]){
      if(typeof log.data!=="string"||
        (log.stream!==undefined&&log.stream!==1&&log.stream!==2))continue;
      const text=decodeLog(log.data);
      if(text===undefined)continue;
      const vertex=log.vertex||null;
      const vertexKey=vertex??"";
      const combined=(this.pending.get(vertexKey)??"")+text.replace(/\r\n?/gu,"\n");
      const lines=combined.split("\n");
      const trailing=lines.pop()??"";
      for(const line of lines)this.addSafeLog(vertex,line);
      this.setPending(vertexKey,trailing);
    }
  }

  consumeUnstructuredStderr(line:string):void{
    this.addStderr(line);
  }

  read(): BuildKitDiagnosticExcerpt | undefined {
    const failedVertex=[...this.failedVertices].reverse().find((vertex)=>
      this.logEntries.some((log)=>log.vertex===vertex))??
      [...this.failedVertices].reverse()[0]??null;
    const pendingVertices=failedVertex===null
      ?[...this.pending.keys()]
      :[...new Set([failedVertex,...(this.pending.has("")?[""] : [])])];
    for(const vertex of pendingVertices){
      const pending=this.pending.get(vertex);
      if(pending)this.addSafeLog(vertex||null,pending);
    }
    const entries=failedVertex===null
      ?[...this.logEntries,...this.errorEntries]
      :[
        ...this.logEntries.filter((item)=>item.vertex===failedVertex||item.vertex===null),
        ...this.errorEntries.filter((item)=>item.vertex===failedVertex||item.vertex===null),
      ];
    entries.sort((left,right)=>left.sequence-right.sequence);
    const primary=entries.map((item)=>item.text).join("\n");
    const captured=primary||this.stderrEntries.map((item)=>item.text).join("\n");
    const safe=sanitizeBuildKitDiagnostic(captured);
    if(!safe)return undefined;
    return {text:safe.text,truncated:this.truncated||safe.truncated};
  }
}

export function createBuildctlRunner(
  config: Pick<BuildKitProviderConfig, "buildctlPath">,
): BuildctlRunner {
  return (args, options) =>
    new Promise<void>((resolve, reject) => {
      if (options.signal.aborted) {
        reject(new BuildKitAttemptError("BUILD_CANCELED", true));
        return;
      }

      const environment: NodeJS.ProcessEnv = {
        DOCKER_CONFIG: options.dockerConfigDirectory,
        HOME: options.temporaryDirectory,
        LANG: "C",
        PATH: options.safePath,
        TMPDIR: options.temporaryDirectory,
      };
      const child = spawn(config.buildctlPath, [...args], {
        cwd: options.cwd,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });

      let totalBytes = 0;
      // Keep rawjson and text framing separate. Only non-JSON stderr becomes
      // bounded sanitized fallback evidence; arbitrary stdout stays private.
      const buffers = { stdout: "", stderr: "" };
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      type OutputStream = keyof typeof buffers;
      let terminalReason: "timeout" | "canceled" | "output-limit" | null = null;
      const diagnostics = new BuildKitDiagnosticCapture();
      let killTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const failOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const terminate = (reason: "timeout" | "canceled" | "output-limit"): void => {
        if (terminalReason !== null) return;
        terminalReason = reason;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        killTimer.unref();
      };
      const onAbort = (): void => terminate("canceled");
      options.signal.addEventListener("abort", onAbort, { once: true });
      const timeoutTimer = setTimeout(() => terminate("timeout"), options.buildTimeoutMs);
      timeoutTimer.unref();

      const consumeLine = (line: string, stream:OutputStream): void => {
        if (Buffer.byteLength(line, "utf8") > 64 * 1024) {
          terminate("output-limit");
          return;
        }
        const parsed = parseProgressLine(line);
        if (parsed) {
          diagnostics.consume(parsed.value);
          if (parsed.progress) options.onProgress(parsed.progress);
        }else if(stream==="stderr"){
          diagnostics.consumeUnstructuredStderr(line);
        }
      };
      const consume = (chunk: Buffer, stream: OutputStream): void => {
        totalBytes += chunk.byteLength;
        if (totalBytes > options.maxProgressBytes) {
          terminate("output-limit");
          return;
        }
        buffers[stream] += decoders[stream].write(chunk);
        let newline = buffers[stream].indexOf("\n");
        while (newline >= 0) {
          const line = buffers[stream].slice(0, newline);
          buffers[stream] = buffers[stream].slice(newline + 1);
          consumeLine(line,stream);
          if (terminalReason !== null) return;
          newline = buffers[stream].indexOf("\n");
        }
        if (Buffer.byteLength(buffers[stream], "utf8") > 64 * 1024) terminate("output-limit");
      };

      child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
      child.once("error", () => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        options.signal.removeEventListener("abort", onAbort);
        failOnce(new BuildKitAttemptError("BUILD_FAILED", true));
      });
      child.once("close", (code) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        options.signal.removeEventListener("abort", onAbort);
        if (settled) return;
        for (const stream of ["stdout", "stderr"] as const) {
          buffers[stream] += decoders[stream].end();
          if (buffers[stream]) consumeLine(buffers[stream],stream);
        }
        if (terminalReason === "timeout") {
          failOnce(new BuildKitAttemptError("BUILD_TIMEOUT", true, diagnostics.read()));
        } else if (terminalReason === "canceled" || options.signal.aborted) {
          failOnce(new BuildKitAttemptError("BUILD_CANCELED", true, diagnostics.read()));
        } else if (terminalReason === "output-limit" || code !== 0) {
          const exitCode = terminalReason === null && typeof code === "number" ? code : undefined;
          failOnce(new BuildKitAttemptError(
            "BUILD_FAILED", terminalReason === "output-limit", diagnostics.read(), exitCode,
          ));
        } else {
          resolve();
        }
      });
    });
}
