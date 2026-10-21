import { describe, expect, it } from "vitest";
import { readBoundedJson, RequestTooLargeError } from "./http.js";

function streamed(chunks: Uint8Array[], onCancel = () => undefined): Request {
  return new Request("https://control.example/", {
    method: "POST", headers: { "Content-Length": "1" },
    body: new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk); else controller.close();
      },
      cancel: onCancel,
    }),
    duplex: "half",
  } as RequestInit);
}

describe("bounded HTTP JSON", () => {
  it("counts real bytes across chunks and cancels despite a lying length", async () => {
    let canceled = false;
    const encode = (s: string) => new TextEncoder().encode(s);
    const request = streamed([encode('{"a":"'), encode("ééé"), encode('"}')], () => { canceled = true; });
    await expect(readBoundedJson(request, 10)).rejects.toBeInstanceOf(RequestTooLargeError);
    expect(canceled).toBe(true);
  });
  it("parses exact-limit split UTF-8 and rejects malformed encodings/JSON", async () => {
    const bytes = new TextEncoder().encode('{"a":"é"}');
    await expect(readBoundedJson(streamed([bytes.slice(0, 7), bytes.slice(7)]), bytes.length)).resolves.toEqual({ a: "é" });
    await expect(readBoundedJson(streamed([new Uint8Array([0xff])]), 10)).rejects.toBeInstanceOf(SyntaxError);
    await expect(readBoundedJson(streamed([new TextEncoder().encode("{")]), 10)).rejects.toBeInstanceOf(SyntaxError);
  });
});
