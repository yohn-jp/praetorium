import { describe, expect, it, vi } from "vitest";
import controlPlane, { type ControlPlaneEnv } from "./worker.js";

describe("Control Plane scheduled production path", () => {
  it.each([false, true])("purges expired evidence and credentials with optional releases disabled (legacy schema: %s)", async (legacySchema) => {
    const statements: string[] = [];
    const statement = {
      bind() {
        return this;
      },
      async run() {
        return { meta: { changes: 0 } };
      },
    };
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        if (legacySchema && sql.includes("source_release_build_attempts"))
          throw new Error("D1_ERROR: no such table: source_release_build_attempts");
        return statement;
      },
    };
    const waitUntil = vi.fn();
    const env = {
      CONTROL_PLANE_DB: db,
      CONTROL_PLANE_GATEWAY_AUTH: "g".repeat(32),
      REPOSITORY_COORDINATOR: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
      },
    } as unknown as ControlPlaneEnv;

    const result = await controlPlane.scheduled(
      { cron: "*/5 * * * *", scheduledTime: 0 },
      env,
      { waitUntil },
    );

    expect(result).toEqual({ releaseWork: "disabled" });
    expect(statements).toEqual(
      expect.arrayContaining([expect.stringContaining("DELETE FROM runtime_git_credentials"),
        expect.stringContaining("UPDATE source_release_build_attempts SET diagnostic_json=NULL")]),
    );
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});
