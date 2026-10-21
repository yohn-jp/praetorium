/** Raised when a streamed HTTP request body exceeds its caller's byte limit. */
export class RequestTooLargeError extends Error {
  constructor() {
    super("request body exceeds configured byte limit");
    this.name = "RequestTooLargeError";
  }
}

/**
 * Read and parse a JSON request body while retaining at most `maxBytes` of
 * decoded input. The byte count comes from the stream itself; Content-Length
 * is deliberately not trusted as the enforcement boundary.
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("request body is required");

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* The size limit remains authoritative. */ }
        throw new RequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("request body is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyntaxError("request body is not valid JSON");
  }
}
