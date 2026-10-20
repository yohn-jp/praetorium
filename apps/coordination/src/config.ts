import { isIP } from "node:net";
import path from "node:path";
import { open } from "node:fs/promises";

const WORK_NOTIFICATION_PATH = "/internal/work-available";
const TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/u;

export type NotificationTarget = {
  readonly url: string;
  readonly token: string;
};

export type CoordinationConfig = {
  readonly host: string;
  readonly port: number;
  readonly targets: {
    readonly operation: NotificationTarget;
    readonly build: NotificationTarget;
  };
};

type CoordinationConfigPaths = {
  readonly host: string;
  readonly port: number;
  readonly targets: {
    readonly operation: { readonly url: string; readonly tokenFile: string };
    readonly build: { readonly url: string; readonly tokenFile: string };
  };
};

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0 || value.trim() !== value || value.length > 4096) {
    throw new TypeError(`invalid coordination configuration: ${name}`);
  }
  return value;
}

function tokenFile(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`invalid coordination configuration: ${name}`);
  }
  return value;
}

function port(environment: NodeJS.ProcessEnv): number {
  const raw = environment.PRAETORIUM_COORDINATION_PORT ?? "8789";
  if (!/^[0-9]{1,5}$/u.test(raw)) {
    throw new TypeError("invalid coordination configuration: PRAETORIUM_COORDINATION_PORT");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError("invalid coordination configuration: PRAETORIUM_COORDINATION_PORT");
  }
  return value;
}

function endpoint(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`invalid coordination configuration: ${name}`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.host.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== WORK_NOTIFICATION_PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`invalid coordination configuration: ${name}`);
  }
  return url.toString();
}

export function readCoordinationConfigPaths(
  environment: NodeJS.ProcessEnv = process.env,
): CoordinationConfigPaths {
  const host = environment.PRAETORIUM_COORDINATION_HOST ?? "0.0.0.0";
  if (isIP(host) === 0) {
    throw new TypeError("invalid coordination configuration: PRAETORIUM_COORDINATION_HOST");
  }
  return {
    host,
    port: port(environment),
    targets: {
      operation: {
        url: endpoint(environment, "PRAETORIUM_COORDINATION_PROVISIONER_NOTIFICATION_URL"),
        tokenFile: tokenFile(
          environment,
          "PRAETORIUM_COORDINATION_PROVISIONER_NOTIFICATION_TOKEN_FILE",
        ),
      },
      build: {
        url: endpoint(environment, "PRAETORIUM_COORDINATION_BUILD_NOTIFICATION_URL"),
        tokenFile: tokenFile(environment, "PRAETORIUM_COORDINATION_BUILD_NOTIFICATION_TOKEN_FILE"),
      },
    },
  };
}

async function readTokenFile(filePath: string): Promise<string> {
  const file = await open(filePath, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 514) {
      throw new TypeError("coordination credential file is invalid");
    }
    const bytes = await file.readFile();
    if (bytes.byteLength > 514) {
      throw new TypeError("coordination credential file is invalid");
    }
    let token = bytes.toString("utf8");
    if (token.endsWith("\r\n")) token = token.slice(0, -2);
    else if (token.endsWith("\n")) token = token.slice(0, -1);
    if (!TOKEN_PATTERN.test(token)) {
      throw new TypeError("coordination credential file is invalid");
    }
    return token;
  } finally {
    await file.close();
  }
}

export async function loadCoordinationConfig(
  environment: NodeJS.ProcessEnv = process.env,
  readCredential: (filePath: string) => Promise<string> = readTokenFile,
): Promise<CoordinationConfig> {
  const paths = readCoordinationConfigPaths(environment);
  const [operationToken, buildToken] = await Promise.all([
    readCredential(paths.targets.operation.tokenFile),
    readCredential(paths.targets.build.tokenFile),
  ]);
  if (operationToken === buildToken) {
    throw new TypeError("provisioner and build notification credentials must be distinct");
  }
  return {
    host: paths.host,
    port: paths.port,
    targets: {
      operation: { url: paths.targets.operation.url, token: operationToken },
      build: { url: paths.targets.build.url, token: buildToken },
    },
  };
}
