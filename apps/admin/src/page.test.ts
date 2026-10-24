import { describe, expect, it } from "vitest";
import { page } from "./page.js";

describe("Admin HTML response headers", () => {
  it("keeps HTML private and prevents intermediary payload transforms", () => {
    const response = page("Operator console", "<h1>Operator console</h1>");

    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; style-src 'self'; script-src 'none'",
    );
  });
});
