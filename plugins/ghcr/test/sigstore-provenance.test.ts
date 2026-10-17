import { generateKeyPairSync, sign } from "node:crypto";
import { bundleToJSON, toDSSEBundle, type Bundle } from "@sigstore/bundle";
import { dsse } from "@sigstore/core";
import { describe, expect, it, vi } from "vitest";
import { SigstoreProvenanceVerifier } from "../src/sigstore-provenance.js";

const digest = `sha256:${"a".repeat(64)}`;
const payloadType = "application/vnd.in-toto+json";
const identity = "https://scriptorium.example/releases";

function signedBundle(
  subjectDigestHex: string,
  predicateType = "https://slsa.dev/provenance/v1",
  statementType = "https://in-toto.io/Statement/v1",
): Bundle {
  const { privateKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(JSON.stringify({
    _type: statementType,
    subject: [
      { name: "scriptorium", digest: { sha256: subjectDigestHex } },
      { name: "scriptorium-build/v1/catalog.json", digest: { sha256: "b".repeat(64) } },
      { name: "scriptorium-platform/v1/runtime-metadata.json", digest: { sha256: "c".repeat(64) } },
    ],
    predicateType,
    predicate: {},
  }), "utf8");
  const signature = sign(null, dsse.preAuthEncoding(payloadType, payload), privateKey);
  return toDSSEBundle({ artifact: payload, artifactType: payloadType, signature, keyHint: "fixture" });
}

function fetchBundle(bundle: Bundle): typeof fetch {
  const body = JSON.stringify(bundleToJSON(bundle));
  return (() => Promise.resolve(new Response(body, { headers: { "content-length": String(body.length) } }))) as unknown as typeof fetch;
}

describe("source Sigstore provenance verification", () => {
  it("rejects non-SLSA statements before treating their subjects as producer metadata", async () => {
    const verify = vi.fn(() => ({ identity: { subjectAlternativeName: identity } }));
    const verifier = new SigstoreProvenanceVerifier({
      signerIdentityAllowlist: [{ subjectAlternativeName: identity }],
      verifier: { verify } as never,
      fetch: fetchBundle(signedBundle(digest.slice("sha256:".length), "https://example.com/other")),
    });
    const result = await verifier.verify({ imageDigest: digest, signatureRef: "https://example.com/bundle", provenanceRef: null });

    expect(result).toEqual({
      verified: false,
      evidence: ["provenance statement has an invalid SLSA predicate or subject list"],
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("requires the signed payload to use the in-toto Statement v1 contract", async () => {
    const verify = vi.fn(() => ({ identity: { subjectAlternativeName: identity } }));
    const verifier = new SigstoreProvenanceVerifier({
      signerIdentityAllowlist: [{ subjectAlternativeName: identity }],
      verifier: { verify } as never,
      fetch: fetchBundle(signedBundle(digest.slice("sha256:".length), undefined, "https://example.com/other")),
    });
    const result = await verifier.verify({ imageDigest: digest, signatureRef: "https://example.com/bundle", provenanceRef: null });

    expect(result).toEqual({
      verified: false,
      evidence: ["provenance statement has an invalid SLSA predicate or subject list"],
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("requires a configured producer identity allowlist", async () => {
    const verifier = new SigstoreProvenanceVerifier({ signerIdentityAllowlist: [] });
    const result = await verifier.verify({ imageDigest: digest, signatureRef: "https://example.com/bundle", provenanceRef: null });

    expect(result).toMatchObject({ verified: false });
    expect(result.evidence[0]).toContain("no producer signer identities");
  });

  it("checks the in-toto subject digest before signature policy evaluation", async () => {
    const verify = vi.fn(() => ({ identity: { subjectAlternativeName: identity } }));
    const verifier = new SigstoreProvenanceVerifier({
      signerIdentityAllowlist: [{ subjectAlternativeName: identity }],
      verifier: { verify } as never,
      fetch: fetchBundle(signedBundle("f".repeat(64))),
    });
    const result = await verifier.verify({ imageDigest: digest, signatureRef: "https://example.com/bundle", provenanceRef: null });

    expect(result.verified).toBe(false);
    expect(result.evidence[0]).toContain("subject does not cover");
    expect(verify).not.toHaveBeenCalled();
  });

  it("applies the configured source identity policy to a signed provenance bundle", async () => {
    const verify = vi.fn((_entity: unknown, policy: { subjectAlternativeName?: string }) => ({
      identity: { subjectAlternativeName: policy.subjectAlternativeName },
    }));
    const verifier = new SigstoreProvenanceVerifier({
      signerIdentityAllowlist: [{ subjectAlternativeName: identity, issuer: "https://issuer.example" }],
      verifier: { verify } as never,
      fetch: fetchBundle(signedBundle(digest.slice("sha256:".length))),
    });
    const result = await verifier.verify({ imageDigest: digest, signatureRef: "https://example.com/bundle", provenanceRef: null });

    expect(result.verified).toBe(true);
    expect(result.signerIdentity).toBe(identity);
    expect(result.attestation).toEqual({
      bundleRef: "https://example.com/bundle",
      predicateType: "https://slsa.dev/provenance/v1",
      subjects: [
        { name: "scriptorium", sha256: digest.slice("sha256:".length) },
        { name: "scriptorium-build/v1/catalog.json", sha256: "b".repeat(64) },
        { name: "scriptorium-platform/v1/runtime-metadata.json", sha256: "c".repeat(64) },
      ],
    });
    expect(verify).toHaveBeenCalledWith(expect.anything(), {
      subjectAlternativeName: identity,
      extensions: { issuer: "https://issuer.example" },
    });
  });

  it("rejects provenance redirects without following or disclosing their target", async () => {
    const redirectTarget = "https://redirect-attacker.example/collect";
    let calls = 0;
    let redirectMode: RequestRedirect | undefined;
    const verifier = new SigstoreProvenanceVerifier({
      signerIdentityAllowlist: [{ subjectAlternativeName: identity }],
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        redirectMode = init?.redirect;
        return new Response("untrusted redirect body", {
          status: 307,
          headers: { location: redirectTarget },
        });
      }) as typeof fetch,
    });

    const result = await verifier.verify({
      imageDigest: digest,
      signatureRef: "https://example.com/bundle",
      provenanceRef: null,
    });

    expect(redirectMode).toBe("manual");
    expect(calls).toBe(1);
    expect(result).toEqual({ verified: false, evidence: ["provenance bundle request returned 307"] });
    expect(JSON.stringify(result)).not.toContain(redirectTarget);
  });

  it("bounds a chunked provenance response without trusting Content-Length", async () => {
    const verifier = new SigstoreProvenanceVerifier({
      signerIdentityAllowlist: [{ subjectAlternativeName: identity }],
      maxBundleBytes: 64,
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(64));
          controller.enqueue(new Uint8Array(64));
        },
      }))) as typeof fetch,
    });
    const result = await verifier.verify({ imageDigest: digest, signatureRef: "https://example.com/bundle", provenanceRef: null });

    expect(result.verified).toBe(false);
    expect(result.evidence[0]).toContain("exceeds the configured size limit");
  });

  it("times out provenance retrieval when response headers never arrive", async () => {
    const verifier = new SigstoreProvenanceVerifier({
      signerIdentityAllowlist: [{ subjectAlternativeName: identity }],
      maxRequestMs: 20,
      fetch: (async () => new Promise<Response>(() => undefined)) as typeof fetch,
    });

    const result = await verifier.verify({ imageDigest: digest, signatureRef: "https://example.com/bundle", provenanceRef: null });

    expect(result.verified).toBe(false);
    expect(result.evidence[0]).toContain("configured time limit");
  });

  it("cancels a stalled provenance body within the request time limit", async () => {
    const stalledBody = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { return undefined; },
    });
    const verifier = new SigstoreProvenanceVerifier({
      signerIdentityAllowlist: [{ subjectAlternativeName: identity }],
      maxRequestMs: 20,
      fetch: (async () => new Response(stalledBody, { headers: { "content-length": "10" } })) as typeof fetch,
    });

    const result = await verifier.verify({ imageDigest: digest, signatureRef: "https://example.com/bundle", provenanceRef: null });

    expect(result.verified).toBe(false);
    expect(result.evidence[0]).toContain("configured time limit");
  });
});
