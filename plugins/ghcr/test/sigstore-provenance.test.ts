import { generateKeyPairSync, sign } from "node:crypto";
import { bundleToJSON, toDSSEBundle, type Bundle } from "@sigstore/bundle";
import { dsse } from "@sigstore/core";
import { describe, expect, it, vi } from "vitest";
import { SigstoreProvenanceVerifier } from "../src/sigstore-provenance.js";

const digest = `sha256:${"a".repeat(64)}`;
const payloadType = "application/vnd.in-toto+json";
const identity = "https://scriptorium.example/releases";

function signedBundle(subjectDigestHex: string): Bundle {
  const { privateKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(JSON.stringify({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "scriptorium", digest: { sha256: subjectDigestHex } }],
    predicateType: "https://slsa.dev/provenance/v1",
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
    expect(verify).toHaveBeenCalledWith(expect.anything(), {
      subjectAlternativeName: identity,
      extensions: { issuer: "https://issuer.example" },
    });
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
});
