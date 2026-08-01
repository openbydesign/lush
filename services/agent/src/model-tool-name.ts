/** Provider-portable function names accepted by OpenAI and Anthropic. */
export const modelToolNameMaxLength = 64;

export function modelToolName(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (sanitized || "tool").slice(0, modelToolNameMaxLength);
}

/** Allocate a deterministic unique name within one capability snapshot. */
export function allocateModelToolName(value: string, used: Set<string>): string {
  const base = modelToolName(value);
  let candidate = base;
  let ordinal = 2;
  while (used.has(candidate)) {
    const suffix = `_${ordinal}`;
    candidate = `${base.slice(0, modelToolNameMaxLength - suffix.length)}${suffix}`;
    ordinal += 1;
  }
  used.add(candidate);
  return candidate;
}
