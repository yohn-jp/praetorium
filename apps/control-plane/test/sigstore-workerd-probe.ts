import { SigstoreProvenanceVerifier } from "@praetorium/ghcr/provenance";
import producerBundle from "../../../docs/verification/producer-008d5c4-39084601122/provenance.sigstore.json" with { type: "json" };

const imageDigest = "sha256:1a64480298fd9cb74f93a0087612b394fffee565684fe22bcc56392a9a6ae120";
const bundleRef =
  "https://raw.githubusercontent.com/yohn-jp/praetorium/a263f6a3ae463679473a69871d7f0f32f3c702ba/docs/verification/producer-008d5c4-39084601122/provenance.sigstore.json";
const signerIdentityAllowlist = [
  {
    subjectAlternativeName:
      "https://github.com/yohn-jp/praetorium/.github/workflows/scriptorium-producer-verification.yml@refs/heads/main",
    issuer: "https://token.actions.githubusercontent.com",
  },
];

function tamperSet(bundle: typeof producerBundle): typeof producerBundle {
  const clone = JSON.parse(JSON.stringify(bundle)) as typeof producerBundle;
  const entry = clone.verificationMaterial.tlogEntries[0];
  if (!entry?.inclusionPromise?.signedEntryTimestamp)
    throw new Error("producer bundle has no Rekor SET");
  const signature = Uint8Array.from(
    atob(entry.inclusionPromise.signedEntryTimestamp),
    (character) => character.charCodeAt(0),
  );
  if (signature.length === 0) throw new Error("producer Rekor SET is empty");
  signature[0] ^= 1;
  entry.inclusionPromise.signedEntryTimestamp = btoa(String.fromCharCode(...signature));
  return clone;
}

function verifierFor(bundle: typeof producerBundle): SigstoreProvenanceVerifier {
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  return new SigstoreProvenanceVerifier({
    signerIdentityAllowlist,
    // Keep transport local and deterministic. This is the real verifier and
    // trusted root; only the committed signed input is supplied as a response.
    fetch: async (request) =>
      new URL(String(request)).href === bundleRef
        ? new Response(bytes.slice(), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(bytes.byteLength),
            },
          })
        : new Response(null, { status: 404 }),
  });
}

export default {
  async fetch(): Promise<Response> {
    const valid = await verifierFor(producerBundle).verify({
      imageDigest,
      signatureRef: bundleRef,
      provenanceRef: null,
    });
    const tampered = await verifierFor(tamperSet(producerBundle)).verify({
      imageDigest,
      signatureRef: bundleRef,
      provenanceRef: null,
    });
    return Response.json({
      valid: valid.verified,
      validSigner: valid.signerIdentity,
      tampered: tampered.verified,
      tamperedEvidence: tampered.evidence,
      checks: [
        "actual SigstoreProvenanceVerifier",
        "actual Sigstore trust root",
        "actual Worker crypto runtime",
        "tracked producer bundle with one Rekor SET byte changed for rejection case",
      ],
    });
  },
};
