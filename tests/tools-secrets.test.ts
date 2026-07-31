import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  encryptSecret,
  decryptSecret,
  secretEnvelopeNeedsRotation,
  SecretError
} from "../services/tools/src/secrets";

describe("tool credential envelope encryption", () => {
  let previousSecret: string | undefined;
  let previousToolKey: string | undefined;
  let previousToolKeys: string | undefined;

  beforeAll(() => {
    previousSecret = process.env.LUSH_SECRET_KEY;
    previousToolKey = process.env.LUSH_TOOL_CREDENTIAL_KEY;
    previousToolKeys = process.env.LUSH_TOOL_CREDENTIAL_KEY_PREVIOUS;
    process.env.LUSH_SECRET_KEY = "unit-test-secret";
    process.env.LUSH_TOOL_CREDENTIAL_KEY = "unit-test-tool-key";
    delete process.env.LUSH_TOOL_CREDENTIAL_KEY_PREVIOUS;
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.LUSH_SECRET_KEY;
    } else {
      process.env.LUSH_SECRET_KEY = previousSecret;
    }
    restoreEnv("LUSH_TOOL_CREDENTIAL_KEY", previousToolKey);
    restoreEnv("LUSH_TOOL_CREDENTIAL_KEY_PREVIOUS", previousToolKeys);
  });

  const context = { connectionId: "conn-1", subjectUserId: "organization" };

  test("round-trips a secret without exposing plaintext in the envelope", async () => {
    const envelope = await encryptSecret("s3cr3t-token", context);
    expect(envelope).not.toContain("s3cr3t-token");
    expect(JSON.parse(envelope)).toMatchObject({ v: 2, alg: "AES-GCM" });
    expect(await decryptSecret(envelope, context)).toBe("s3cr3t-token");
  });

  test("fails to decrypt when the connection context differs (AAD binding)", async () => {
    const envelope = await encryptSecret("s3cr3t-token", context);
    await expect(
      decryptSecret(envelope, { connectionId: "conn-2", subjectUserId: "organization" })
    ).rejects.toMatchObject({ code: "credential_unavailable", status: 409 });
  });

  test("decrypts regardless of context key insertion order (stable AAD)", async () => {
    const envelope = await encryptSecret("s3cr3t-token", {
      connectionId: "conn-1",
      subjectUserId: "organization"
    });
    // Same logical context, keys inserted in the opposite order.
    const reordered = { subjectUserId: "organization", connectionId: "conn-1" };
    expect(await decryptSecret(envelope, reordered)).toBe("s3cr3t-token");
  });

  test("reads PR #101 legacy envelopes and marks them for rewrite", async () => {
    const envelope = await legacyEnvelope("legacy-token", context, "unit-test-secret");
    expect(await decryptSecret(envelope, context)).toBe("legacy-token");
    expect(await secretEnvelopeNeedsRotation(envelope)).toBe(true);
  });

  test("rotates with explicit previous roots and rejects removed roots", async () => {
    process.env.LUSH_TOOL_CREDENTIAL_KEY = "old-tool-root";
    const oldEnvelope = await encryptSecret("rotate-me", context);

    process.env.LUSH_TOOL_CREDENTIAL_KEY = "new-tool-root";
    process.env.LUSH_TOOL_CREDENTIAL_KEY_PREVIOUS = "old-tool-root";
    expect(await decryptSecret(oldEnvelope, context)).toBe("rotate-me");
    expect(await secretEnvelopeNeedsRotation(oldEnvelope)).toBe(true);

    const rewritten = await encryptSecret("rotate-me", context);
    expect(await secretEnvelopeNeedsRotation(rewritten)).toBe(false);
    delete process.env.LUSH_TOOL_CREDENTIAL_KEY_PREVIOUS;
    await expect(decryptSecret(oldEnvelope, context)).rejects.toMatchObject({
      code: "credential_key_unavailable",
      status: 500
    });
    expect(await decryptSecret(rewritten, context)).toBe("rotate-me");
  });

  test("does not fall back to the shared auth root for v2 envelopes", async () => {
    process.env.LUSH_TOOL_CREDENTIAL_KEY = "dedicated-root";
    process.env.LUSH_SECRET_KEY = "dedicated-root";
    const envelope = await encryptSecret("isolated", context);
    delete process.env.LUSH_TOOL_CREDENTIAL_KEY;
    await expect(decryptSecret(envelope, context)).rejects.toMatchObject({
      code: "secret_key_missing",
      status: 500
    });
  });

  test("rejects an unsupported envelope version even with a valid key id", async () => {
    process.env.LUSH_TOOL_CREDENTIAL_KEY = "dedicated-root";
    const envelope = JSON.parse(await encryptSecret("versioned", context));
    envelope.v = 3;
    await expect(
      decryptSecret(JSON.stringify(envelope), context)
    ).rejects.toMatchObject({
      code: "credential_envelope_unsupported",
      status: 500
    });
  });
});

async function legacyEnvelope(
  plaintext: string,
  context: Record<string, string>,
  root: string
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(root));
  const key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt"]);
  const aad = new TextEncoder().encode(
    JSON.stringify(Object.keys(context).sort().map((name) => [name, context[name]]))
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(plaintext)
  );
  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    iv: hex(iv),
    ciphertext: hex(new Uint8Array(ciphertext))
  });
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
