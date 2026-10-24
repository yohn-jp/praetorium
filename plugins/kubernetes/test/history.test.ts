import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseHistorySnapshot } from "../src/kubernetes/history.js";

function snapshot(path: string, contents: string, sourcePodUid = "pod-1"): string {
  const bytes = Buffer.from(contents, "utf8");
  const files = [
    {
      path,
      contentBase64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  const canonical = JSON.stringify({ schemaVersion: 1, sourcePodUid, files });
  return JSON.stringify({
    schemaVersion: 1,
    sourcePodUid,
    files,
    manifestSha256: createHash("sha256").update(canonical).digest("hex"),
  });
}

describe("private history snapshot validation", () => {
  it("accepts a canonical bounded regular-file manifest", () => {
    expect(parseHistorySnapshot(snapshot("activity/recent.json", "{}"), "pod-1")).toMatchObject({
      schemaVersion: 1,
      sourcePodUid: "pod-1",
      files: [{ path: "activity/recent.json" }],
    });
  });

  it.each(["../outside", "/absolute", "a\\b", ".praetorium-initialized", "nested//empty"]) (
    "rejects unsafe path %s",
    (path) => {
      expect(() => parseHistorySnapshot(snapshot(path, "{}"), "pod-1")).toThrow();
    },
  );

  it("rejects source UID drift and tampered content", () => {
    expect(() => parseHistorySnapshot(snapshot("a.json", "{}"), "pod-2")).toThrow();
    const tampered = JSON.parse(snapshot("a.json", "{}")) as {
      files: Array<{ contentBase64: string }>;
    };
    tampered.files[0]!.contentBase64 = Buffer.from("changed").toString("base64");
    expect(() => parseHistorySnapshot(JSON.stringify(tampered), "pod-1")).toThrow();
  });
});
