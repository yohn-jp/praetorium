import { err, ok, type Result } from "./domain.js";
import { AccessGrantSchema, type AccessGrant } from "@praetorium/contracts";
import { base64UrlDecode, base64UrlEncode } from "./random.js";

/** The only algorithm this platform ever signs or accepts. */
const ALGORITHM = "ES256" as const;

interface JwsHeader {
  readonly alg: "ES256";
  readonly kid: string;
  readonly typ: "JWT";
}

async function signCompactJwt(header: JwsHeader, payload: object, privateKey: CryptoKey): Promise<string> {
  const encodedHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

interface DecodedJwt {
  readonly header: unknown;
  readonly payload: unknown;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

function decodeCompactJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  try {
    return {
      header: JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedHeader))) as unknown,
      payload: JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as unknown,
      signingInput: `${encodedHeader}.${encodedPayload}`,
      signature: base64UrlDecode(encodedSignature),
    };
  } catch {
    return null;
  }
}

async function verifySignature(decoded: DecodedJwt, publicKey: CryptoKey): Promise<boolean> {
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    decoded.signature as BufferSource,
    new TextEncoder().encode(decoded.signingInput),
  );
}

/**
 * Claims for a short-lived, instance-bound access grant (browser handoff or
 * MCP token exchange). `aud` and `instance_id` are always equal — the
 * platform never issues a token whose audience is anything other than the
 * single instance it authorizes (ADR 0005).
 */
export type AccessTokenClaims = AccessGrant;

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
}

export interface IssueAccessTokenInput {
  readonly issuer: string;
  readonly audience: string;
  readonly subjectUserId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
  readonly permissions: readonly AccessGrant["permissions"][number][];
  readonly sessionRevision: number;
  readonly authorizationRevision: number;
  readonly now: string;
  readonly ttlSeconds: number;
  readonly tokenId: string;
}

export async function issueAccessToken(
  signingKey: SigningKey,
  input: IssueAccessTokenInput,
): Promise<string> {
  const nowSeconds = Math.floor(new Date(input.now).getTime() / 1000);
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 300) {
    throw new TypeError("access grant lifetime must be between 1 and 300 seconds");
  }
  const claims = AccessGrantSchema.parse({
    iss: input.issuer,
    sub: input.subjectUserId,
    aud: input.audience,
    instanceId: input.instanceId,
    repositoryId: input.repositoryId,
    runtimeEpoch: input.runtimeEpoch,
    permissions: [...new Set(input.permissions)],
    sessionRevision: input.sessionRevision,
    authorizationRevision: input.authorizationRevision,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + input.ttlSeconds,
    jti: input.tokenId,
  });

  return signCompactJwt({ alg: ALGORITHM, kid: signingKey.kid, typ: "JWT" }, claims, signingKey.privateKey);
}

export type AccessTokenErrorCode =
  | "MALFORMED"
  | "UNKNOWN_KEY"
  | "BAD_SIGNATURE"
  | "WRONG_ALGORITHM"
  | "WRONG_ISSUER"
  | "WRONG_INSTANCE"
  | "WRONG_REPOSITORY"
  | "WRONG_RUNTIME_EPOCH"
  | "INSUFFICIENT_SCOPE"
  | "EXPIRED"
  | "NOT_YET_VALID";

export interface AccessTokenError {
  readonly code: AccessTokenErrorCode;
  readonly message: string;
}

export interface VerifyAccessTokenInput {
  readonly token: string;
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly expectedInstanceId: string;
  readonly expectedRepositoryId: number;
  readonly expectedRuntimeEpoch: number;
  readonly requiredPermissions?: readonly AccessGrant["permissions"][number][];
  readonly now: string;
  readonly clockSkewSeconds: number;
  /** Backed by the JWKS-published key set; must reject a compromised or unknown `kid`. */
  readonly resolveKey: (kid: string) => Promise<CryptoKey | null>;
}

/**
 * Verifies a compact JWT against a fixed algorithm, issuer, and exactly one
 * instance audience — so a token issued for one instance can never
 * authenticate another.
 */
export async function verifyAccessToken(
  input: VerifyAccessTokenInput,
): Promise<Result<AccessTokenClaims, AccessTokenError>> {
  const decoded = decodeCompactJwt(input.token);
  if (!decoded) {
    return err({ code: "MALFORMED", message: "token is not a well-formed compact JWT" });
  }

  const header = decoded.header as { alg?: unknown; kid?: unknown };
  if (header.alg !== ALGORITHM) {
    return err({ code: "WRONG_ALGORITHM", message: "unsupported signing algorithm" });
  }
  if (typeof header.kid !== "string") {
    return err({ code: "MALFORMED", message: "token header is missing kid" });
  }

  const key = await input.resolveKey(header.kid);
  if (!key) {
    return err({ code: "UNKNOWN_KEY", message: "signing key is unknown or no longer trusted" });
  }

  const validSignature = await verifySignature(decoded, key);
  if (!validSignature) {
    return err({ code: "BAD_SIGNATURE", message: "signature verification failed" });
  }

  const parsed = AccessGrantSchema.safeParse(decoded.payload);
  if (!parsed.success) {
    return err({ code: "MALFORMED", message: "token claims do not match the access grant contract" });
  }
  const payload = parsed.data;
  if (payload.iss !== input.expectedIssuer || payload.aud !== input.expectedAudience) {
    return err({ code: "WRONG_ISSUER", message: "unexpected issuer" });
  }
  if (payload.instanceId !== input.expectedInstanceId) {
    return err({ code: "WRONG_INSTANCE", message: "token is not valid for this instance" });
  }
  if (payload.repositoryId !== input.expectedRepositoryId) {
    return err({ code: "WRONG_REPOSITORY", message: "token is not valid for this repository" });
  }
  if (payload.runtimeEpoch !== input.expectedRuntimeEpoch) {
    return err({ code: "WRONG_RUNTIME_EPOCH", message: "token is not valid for this runtime epoch" });
  }

  const nowSeconds = Math.floor(new Date(input.now).getTime() / 1000);
  if (nowSeconds > payload.exp + input.clockSkewSeconds) {
    return err({ code: "EXPIRED", message: "token has expired" });
  }
  if (nowSeconds + input.clockSkewSeconds < payload.nbf) {
    return err({ code: "NOT_YET_VALID", message: "token is not yet valid" });
  }

  if (input.requiredPermissions && input.requiredPermissions.length > 0) {
    const grantedPermissions = new Set(payload.permissions);
    const hasAllPermissions = input.requiredPermissions.every((permission) =>
      grantedPermissions.has(permission),
    );
    if (!hasAllPermissions) {
      return err({ code: "INSUFFICIENT_SCOPE", message: "token is missing a required permission" });
    }
  }

  return ok(payload);
}
