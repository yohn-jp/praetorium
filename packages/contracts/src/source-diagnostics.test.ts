import { describe, it, expect } from "vitest";
import { sanitizeSourceDiagnostic, SourceBuildDiagnosticSchema, SOURCE_DIAGNOSTIC_MAX_BYTES } from "./source-diagnostics.js";

describe("operator source evidence admission", () => {
  it("keeps attributable compiler failures and canonicalizes arbitrary summaries", () => {
    expect(sanitizeSourceDiagnostic({ stage: "runtime_base", reason: "build_failed", summary: "secret text",
      excerpt: "src/main.ts(12,7): error TS2322: Type string is not assignable to number.\nordinary producer stdout",
      truncated: false })).toMatchObject({ stage: "runtime_base", reason: "build_failed", truncated: true,
      excerpt: "src/main.ts(12,7): error TS2322: Type string is not assignable to number." });
    expect(sanitizeSourceDiagnostic({ stage: "metadata", reason: "timeout", summary: "secret text", truncated: false }).summary)
      .toBe("The execution stage exceeded its time budget.");
  });
  it("excludes authentication, commands, environment, URLs, keys and opaque payloads", () => {
    const lines = ["ERROR: Authorization: Bearer private-value", "failed PASSWORD=private-value", "ERROR RUN npm install",
      "error: command npm run build", "ERROR: failed authentication with response signature " + "s".repeat(32), "fatal https://user:private-value@example.com/private", "error /run/secrets/key",
      "-----BEGIN PRIVATE KEY-----", "error private-value", "-----END PRIVATE KEY-----",
      "error ghp_private-value", "error " + "a".repeat(48), "error GITHUB_TOKEN=private-value", "ERROR curl private-value"];
    const diagnostic = sanitizeSourceDiagnostic({ stage: "buildkit", reason: "build_failed", summary: "private-value",
      excerpt: lines.join("\n"), truncated: false });
    expect(JSON.stringify(diagnostic)).not.toContain("private-value");
    expect(diagnostic.excerpt).toBeUndefined();
    expect(diagnostic.truncated).toBe(true);
  });
  it("caps multibyte evidence in UTF-8 and rejects oversized transport fields", () => {
    const excerpt = Array.from({ length: 30 }, () => "error " + "日".repeat(260)).join("\n");
    const result = sanitizeSourceDiagnostic({ stage: "metadata", reason: "build_failed", summary: "", excerpt, truncated: false });
    expect(new TextEncoder().encode(result.excerpt).byteLength).toBeLessThanOrEqual(SOURCE_DIAGNOSTIC_MAX_BYTES);
    expect(result.truncated).toBe(true);
    expect(SourceBuildDiagnosticSchema.safeParse({ stage: "metadata", reason: "build_failed", summary: "",
      excerpt: "x".repeat(SOURCE_DIAGNOSTIC_MAX_BYTES + 1), truncated: false }).success).toBe(false);
  });
});
