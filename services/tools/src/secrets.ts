/**
 * Envelope encryption for tool credentials.
 *
 * Mirrors the AES-GCM approach used by `services/inference` for provider keys.
 * Ciphertext is bound to the connection context via AAD so an envelope cannot
 * be replayed under a different connection. Plaintext and ciphertext never leave
 * this module; the control plane exposes only opaque credential references.
 */

import { requiredEnvValue } from "@lush/config/env";

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
  const key = await secretKey();
  const aad = new TextEncoder().encode(canonicalizeContext(context));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(plaintext)
  );

  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ciphertext))
  });
}

export async function decryptSecret(
  encrypted: string,
  context: SecretContext
): Promise<string> {
  try {
    const payload = JSON.parse(encrypted) as { iv: string; ciphertext: string };
    const key = await secretKey();
    const aad = new TextEncoder().encode(canonicalizeContext(context));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(payload.iv), additionalData: aad },
      key,
      hexToBytes(payload.ciphertext)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new SecretError(
      "credential_unavailable",
      "Stored tool credential could not be decrypted. Reconnect the tool connection.",
      409
    );
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

async function secretKey() {
  let configured: string;
  try {
    configured = requiredEnvValue("LUSH_SECRET_KEY");
  } catch {
    throw new SecretError(
      "secret_key_missing",
      "LUSH_SECRET_KEY is required to encrypt tool credentials"
    );
  }
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(configured)
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, [
    "encrypt",
    "decrypt"
  ]);
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
