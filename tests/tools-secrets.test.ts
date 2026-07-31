import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encryptSecret, decryptSecret, SecretError } from "../services/tools/src/secrets";

describe("tool credential envelope encryption", () => {
  let previousSecret: string | undefined;

  beforeAll(() => {
    previousSecret = process.env.LUSH_SECRET_KEY;
    process.env.LUSH_SECRET_KEY = "unit-test-secret";
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.LUSH_SECRET_KEY;
    } else {
      process.env.LUSH_SECRET_KEY = previousSecret;
    }
  });

  const context = { connectionId: "conn-1", subjectUserId: "organization" };

  test("round-trips a secret without exposing plaintext in the envelope", async () => {
    const envelope = await encryptSecret("s3cr3t-token", context);
    expect(envelope).not.toContain("s3cr3t-token");
    expect(JSON.parse(envelope)).toMatchObject({ alg: "AES-GCM" });
    expect(await decryptSecret(envelope, context)).toBe("s3cr3t-token");
  });

  test("fails to decrypt when the connection context differs (AAD binding)", async () => {
    const envelope = await encryptSecret("s3cr3t-token", context);
    await expect(
      decryptSecret(envelope, { connectionId: "conn-2", subjectUserId: "organization" })
    ).rejects.toBeInstanceOf(SecretError);
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
});
