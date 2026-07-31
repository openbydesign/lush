/**
 * Envelope encryption for tool credentials.
 *
 * Mirrors the AES-GCM approach used by `services/inference` for provider keys.
 * Ciphertext is bound to the connection context via AAD so an envelope cannot
 * be replayed under a different connection. Plaintext and ciphertext never leave
 * this module; the control plane exposes only opaque credential references.
 */

import { commaListEnv, requiredEnvValue } from "@lush/config/env";

const KEY_INFO = "lush/tools/credential-encryption/v1";
const HKDF_SALT = "lush/tools/hkdf-salt/v1";

export class SecretError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500
  ) {
    super(message);
    this.name = "SecretError";
  }
}

export type SecretContext = Record<string, string>;

export async function encryptSecret(
  plaintext: string,
  context: SecretContext
): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const active = await activeKey();
  const aad = new TextEncoder().encode(canonicalizeContext(context));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    active.key,
    new TextEncoder().encode(plaintext)
  );

  return JSON.stringify({
    v: 2,
    alg: "AES-GCM",
    kid: active.id,
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ciphertext))
  });
}

export async function decryptSecret(
  encrypted: string,
  context: SecretContext
): Promise<string> {
  try {
    const payload = JSON.parse(encrypted) as {
      v?: number;
      kid?: string;
      iv: string;
      ciphertext: string;
    };
    const aad = new TextEncoder().encode(canonicalizeContext(context));
    let candidates: DerivedKey[];
    if (payload.v === 1 || payload.v === undefined) {
      candidates = [await legacyKey()];
    } else if (payload.v === 2) {
      if (typeof payload.kid !== "string" || !payload.kid) {
        throw new Error("Credential envelope is missing its key identifier");
      }
      candidates = (await keyRing()).filter(
        (candidate) => candidate.id === payload.kid
      );
      if (candidates.length === 0) {
        throw new SecretError(
          "credential_key_unavailable",
          "Stored tool credential requires a configured key that is not present in the active or previous credential key ring"
        );
      }
    } else {
      throw new SecretError(
        "credential_envelope_unsupported",
        "Stored tool credential uses an unsupported envelope version"
      );
    }
    for (const candidate of candidates) {
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: hexToBytes(payload.iv), additionalData: aad },
          candidate.key,
          hexToBytes(payload.ciphertext)
        );
        return new TextDecoder().decode(plaintext);
      } catch {
        // Try the next explicitly configured legacy root. Authentication errors
        // are collapsed below so callers never learn key-ring details.
      }
    }
    throw new Error("No configured credential key could decrypt the envelope");
  } catch (error) {
    // Configuration and envelope-version failures require operator action.
    // Do not turn them into a user-facing reconnect prompt: replacing the
    // credential cannot recover ciphertext whose key was removed by mistake.
    if (error instanceof SecretError) throw error;
    throw new SecretError(
      "credential_unavailable",
      "Stored tool credential could not be decrypted. Reconnect the tool connection.",
      409
    );
  }
}

/** True when a successful read should be rewritten under the active v2 key. */
export async function secretEnvelopeNeedsRotation(encrypted: string): Promise<boolean> {
  try {
    const payload = JSON.parse(encrypted) as { v?: number; kid?: string };
    const active = await activeKey();
    return payload.v !== 2 || payload.kid !== active.id;
  } catch {
    return true;
  }
}

/**
 * Serialize the AAD context with keys in a stable order so encrypt and decrypt
 * derive identical additional data regardless of how the caller built the
 * context object. `JSON.stringify` preserves insertion order, which would make
 * decryption depend on key ordering.
 */
function canonicalizeContext(context: SecretContext): string {
  const sorted = Object.keys(context)
    .sort()
    .map((key): [string, string] => [key, context[key] as string]);
  return JSON.stringify(sorted);
}

type DerivedKey = { id: string; key: CryptoKey };

async function activeKey(): Promise<DerivedKey> {
  let configured: string;
  try {
    configured = requiredEnvValue("LUSH_TOOL_CREDENTIAL_KEY");
  } catch {
    throw new SecretError(
      "secret_key_missing",
      "LUSH_TOOL_CREDENTIAL_KEY is required to encrypt tool credentials"
    );
  }
  return deriveKey(configured);
}

async function keyRing(): Promise<DerivedKey[]> {
  const active = await activeKey();
  const previous = await Promise.all(
    Array.from(new Set(commaListEnv("LUSH_TOOL_CREDENTIAL_KEY_PREVIOUS"))).map(
      deriveKey
    )
  );
  return [active, ...previous.filter((candidate) => candidate.id !== active.id)];
}

async function deriveKey(root: string): Promise<DerivedKey> {
  const rootBytes = new TextEncoder().encode(root);
  const material = await crypto.subtle.importKey("raw", rootBytes, "HKDF", false, [
    "deriveKey"
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(HKDF_SALT),
      info: new TextEncoder().encode(KEY_INFO)
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const idMaterial = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${KEY_INFO}\u0000${root}`)
  );
  return { id: bytesToHex(new Uint8Array(idMaterial)).slice(0, 16), key };
}

async function legacyKey(): Promise<DerivedKey> {
  let configured: string;
  try {
    configured = requiredEnvValue("LUSH_SECRET_KEY");
  } catch {
    throw new SecretError(
      "legacy_secret_key_missing",
      "LUSH_SECRET_KEY is required to read legacy tool credentials"
    );
  }
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(configured)
  );
  const key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, [
    "encrypt",
    "decrypt"
  ]);
  return { id: "legacy-v1", key };
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
