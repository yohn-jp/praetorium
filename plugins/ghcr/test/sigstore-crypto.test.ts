import { readFile } from "node:fs/promises";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { crypto as sigstoreCrypto } from "@sigstore/core";
import { describe, expect, it } from "vitest";
import { SigstoreProvenanceVerifier } from "../src/sigstore-provenance.js";

const producerBundlePath = new URL(
  "../../../docs/verification/producer-008d5c4-39084601122/provenance.sigstore.json",
  import.meta.url,
);
const producerDigest = "sha256:1a64480298fd9cb74f93a0087612b394fffee565684fe22bcc56392a9a6ae120";
const producerIdentity = "https://github.com/yohn-jp/praetorium/.github/workflows/scriptorium-producer-verification.yml@refs/heads/main";
const producerIssuer = "https://token.actions.githubusercontent.com";
const producerBundleUrl = "https://example.invalid/provenance.sigstore.json";

interface ProducerBundleJson {
  readonly verificationMaterial: {
    readonly tlogEntries: readonly {
      readonly inclusionPromise: { readonly signedEntryTimestamp: string };
    }[];
  };
  readonly [key: string]: unknown;
}

function verifierFor(bundle: ProducerBundleJson): SigstoreProvenanceVerifier {
  const body = JSON.stringify(bundle);
  return new SigstoreProvenanceVerifier({
    signerIdentityAllowlist: [{ subjectAlternativeName: producerIdentity, issuer: producerIssuer }],
    fetch: (async () => new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } })) as typeof fetch,
  });
}

describe("Sigstore crypto compatibility", () => {
  it("uses Node-compatible SHA-256 when an EC digest is omitted or null", () => {
    for (const namedCurve of ["prime256v1", "secp384r1", "secp521r1"] as const) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve });
      const data = Buffer.from(`default digest compatibility: ${namedCurve}`);
      const signature = nodeSign("sha256", data, privateKey);

      expect(sigstoreCrypto.verify(data, publicKey, signature), `${namedCurve} omitted digest`).toBe(true);
      expect(sigstoreCrypto.verify(data, publicKey, signature, null as never), `${namedCurve} null digest`).toBe(true);
    }
  });

  it("preserves explicit ECDSA digest selection and rejects altered signatures", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const data = Buffer.from("explicit digest must remain authoritative");
    const signature = nodeSign("sha384", data, privateKey);

    expect(sigstoreCrypto.verify(data, publicKey, signature, "sha384")).toBe(true);
    expect(sigstoreCrypto.verify(data, publicKey, signature)).toBe(false);

    const tampered = Buffer.from(signature);
    tampered[tampered.length - 1] ^= 1;
    expect(sigstoreCrypto.verify(data, publicKey, tampered, "sha384")).toBe(false);
  });

  it("leaves Ed25519 null-digest verification unchanged", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const data = Buffer.from("Ed25519 requires a null digest");
    const signature = nodeSign(null, data, privateKey);

    expect(sigstoreCrypto.verify(data, publicKey, signature)).toBe(true);
    expect(sigstoreCrypto.verify(data, publicKey, signature, null as never)).toBe(true);
  });

  it("verifies the real producer bundle and rejects a tampered Rekor SET", async () => {
    const realBundle = JSON.parse(await readFile(producerBundlePath, "utf8")) as ProducerBundleJson;
    const validResult = await verifierFor(realBundle).verify({
      imageDigest: producerDigest,
      signatureRef: producerBundleUrl,
      provenanceRef: null,
    });
    expect(validResult.verified).toBe(true);
    expect(validResult.signerIdentity).toBe(producerIdentity);

    const firstEntry = realBundle.verificationMaterial.tlogEntries[0];
    expect(firstEntry).toBeDefined();
    const signatureBytes = Buffer.from(firstEntry!.inclusionPromise.signedEntryTimestamp, "base64");
    signatureBytes[signatureBytes.length - 1] ^= 1;
    const tamperedBundle = structuredClone(realBundle);
    const tamperedEntry = tamperedBundle.verificationMaterial.tlogEntries[0];
    expect(tamperedEntry).toBeDefined();
    const tamperedMaterial = {
      ...tamperedBundle.verificationMaterial,
      tlogEntries: tamperedBundle.verificationMaterial.tlogEntries.map((entry, index) =>
        index === 0
          ? { ...entry, inclusionPromise: { ...entry.inclusionPromise, signedEntryTimestamp: signatureBytes.toString("base64") } }
          : entry,
      ),
    };
    const result = await verifierFor({ ...tamperedBundle, verificationMaterial: tamperedMaterial }).verify({
      imageDigest: producerDigest,
      signatureRef: producerBundleUrl,
      provenanceRef: null,
    });

    expect(result.verified).toBe(false);
    expect(result.evidence).toContain("signature or producer identity verification failed");
  });
});
