import { err, ok, type Result } from "../domain.js";
import { importPublicKeyJwk } from "./crypto.js";

/**
 * `active` signs new tokens. `next` is published but not yet used for
 * signing, so instances trust it before cutover. `retired` no longer signs
 * but must stay published until every token it signed could have expired.
 * `compromised` is the emergency-rotation exception: removed from
 * publication immediately, accepting that still-unexpired tokens it signed
 * will fail verification.
 */
export type KeyStatus = "active" | "next" | "retired" | "compromised";

export interface KeyRecord {
  readonly kid: string;
  readonly status: KeyStatus;
  readonly publicKeyJwk: JsonWebKey;
  readonly createdAt: string;
  readonly retiredAt: string | null;
}

export type KeyRotationErrorCode =
  | "NO_NEXT_KEY"
  | "NEXT_KEY_ALREADY_PENDING"
  | "NO_ACTIVE_KEY"
  | "INVALID_PUBLIC_KEY";

export interface KeyRotationError {
  readonly code: KeyRotationErrorCode;
  readonly message: string;
}

const PRIVATE_JWK_MEMBERS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);

/** Returns only the public P-256 members used by ES256, rejecting private key material. */
function publicP256Members(value: JsonWebKey): Pick<JsonWebKey, "kty" | "crv" | "x" | "y"> | null {
  const candidate = value as JsonWebKey & Record<string, unknown>;
  if (Object.keys(candidate).some((member) => PRIVATE_JWK_MEMBERS.has(member))) return null;
  if (
    candidate.kty !== "EC" ||
    candidate.crv !== "P-256" ||
    typeof candidate.x !== "string" ||
    candidate.x.length === 0 ||
    typeof candidate.y !== "string" ||
    candidate.y.length === 0
  )
    return null;
  return { kty: "EC", crv: "P-256", x: candidate.x, y: candidate.y };
}

/** Registers a newly generated key as `next`. At most one `next` key may be pending at a time. */
export function addNextKey(
  keys: readonly KeyRecord[],
  candidate: Pick<KeyRecord, "kid" | "publicKeyJwk" | "createdAt">,
): Result<readonly KeyRecord[], KeyRotationError> {
  const publicKeyJwk = publicP256Members(candidate.publicKeyJwk);
  if (!publicKeyJwk) {
    return err({ code: "INVALID_PUBLIC_KEY", message: "a public P-256 signing key is required" });
  }
  if (keys.some((key) => key.status === "next")) {
    return err({
      code: "NEXT_KEY_ALREADY_PENDING",
      message: "a next key is already pending promotion",
    });
  }
  return ok([...keys, { ...candidate, publicKeyJwk, status: "next", retiredAt: null }]);
}

/**
 * Promotes `next` to `active`, retiring the previous `active` key. The
 * retired key stays published (see `buildJwksDocument`) so tokens it
 * already signed keep verifying through the overlap period.
 */
export function promoteNextKey(
  keys: readonly KeyRecord[],
  now: string,
): Result<readonly KeyRecord[], KeyRotationError> {
  const next = keys.find((key) => key.status === "next");
  if (!next) {
    return err({ code: "NO_NEXT_KEY", message: "no next key is pending promotion" });
  }

  return ok(
    keys.map((key) => {
      if (key.kid === next.kid) {
        return { ...key, status: "active" };
      }
      if (key.status === "active") {
        return { ...key, status: "retired", retiredAt: now };
      }
      return key;
    }),
  );
}

/**
 * Emergency rotation: immediately excludes a compromised key from
 * publication rather than waiting out its overlap period. This is the one
 * intentional exception to "never remove a key while it could still verify
 * an unexpired token" — the compromise itself is the reason to accept that
 * cost.
 */
export function emergencyRevokeKey(
  keys: readonly KeyRecord[],
  kid: string,
  now: string,
): readonly KeyRecord[] {
  return keys.map((key) =>
    key.kid === kid ? { ...key, status: "compromised", retiredAt: now } : key,
  );
}

/**
 * A `retired` key is only safe to delete once every token it could have
 * signed has passed the longest possible token lifetime. `compromised`
 * keys are never "safe" in this sense — they are removed from publication
 * immediately instead, and deleting the key material is a separate,
 * deliberate incident-response step outside this pure state machine.
 */
export function canDeleteKey(
  key: KeyRecord,
  maxTokenLifetimeSeconds: number,
  now: string,
): boolean {
  if (key.status !== "retired" || !key.retiredAt) {
    return false;
  }
  const safeAtMs = new Date(key.retiredAt).getTime() + maxTokenLifetimeSeconds * 1000;
  return new Date(now).getTime() >= safeAtMs;
}

export function removeDeletableKeys(
  keys: readonly KeyRecord[],
  maxTokenLifetimeSeconds: number,
  now: string,
): readonly KeyRecord[] {
  return keys.filter((key) => !canDeleteKey(key, maxTokenLifetimeSeconds, now));
}

export interface JwksDocument {
  readonly keys: readonly JsonWebKey[];
}

/** Every published key carries a restricted `alg`/`use` so a verifier can never be tricked into a different algorithm. */
export function buildJwksDocument(keys: readonly KeyRecord[]): JwksDocument {
  return {
    keys: keys
      .filter((key) => key.status !== "compromised")
      .map((key) => {
        const publicKey = publicP256Members(key.publicKeyJwk);
        if (!publicKey) throw new TypeError("key registry contains invalid public key material");
        return { ...publicKey, kid: key.kid, alg: "ES256", use: "sig" };
      }),
  };
}

/** Resolves a `kid` to a verification key. Any non-compromised status is verify-eligible, matching `buildJwksDocument`. */
export async function resolveVerificationKey(
  keys: readonly KeyRecord[],
  kid: string,
): Promise<CryptoKey | null> {
  const record = keys.find((key) => key.kid === kid && key.status !== "compromised");
  if (!record) {
    return null;
  }
  const publicKey = publicP256Members(record.publicKeyJwk);
  if (!publicKey) return null;
  return importPublicKeyJwk(publicKey);
}
