/**
 * Stable digests for tool definitions and normalized inputs.
 *
 * A definition digest lets the gateway detect that a catalog changed since the
 * agent snapshotted its capabilities. An input digest binds an approval to the
 * exact normalized arguments, so editing arguments invalidates the approval.
 */

/** Canonical JSON: object keys sorted recursively so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function digestValue(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
