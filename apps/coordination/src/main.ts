import { pathToFileURL } from "node:url";
import { loadCoordinationConfig } from "./config.js";
import { closeCoordinationServer, startCoordinationServer } from "./notification-relay.js";

export async function main(): Promise<void> {
  const config = await loadCoordinationConfig();
  const server = await startCoordinationServer(config);
  const stop = (): void => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    void closeCoordinationServer(server).catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Coordination service startup failed\n");
    process.exitCode = 1;
  });
}
