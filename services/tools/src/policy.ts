import type { ToolAnnotations } from "@lush/db/schema";

export type ToolPolicyDecision = "allow" | "approve" | "deny";

export type ToolPolicyExplanation = {
  decision: ToolPolicyDecision;
  reasons: string[];
};

/** Resolve the effective decision from Lush-owned policy and risk metadata. */
export function explainToolPolicy(
  annotations: ToolAnnotations,
  policy: unknown
): ToolPolicyExplanation {
  const rules = isObject(policy) ? policy : {};
  if (rules.deny === true) {
    return { decision: "deny", reasons: ["connection_policy_denied"] };
  }

  if (rules.approval === "every_call") {
    return {
      decision: "approve",
      reasons: ["connection_policy_requires_approval"]
    };
  }
  if (rules.approval === "never") {
    return {
      decision: "allow",
      reasons: ["connection_policy_allows_without_approval"]
    };
  }

  const reasons: string[] = [];
  if (annotations.destructive) reasons.push("tool_destructive");
  if (annotations.openWorld) reasons.push("tool_open_world");
  if (reasons.length > 0) return { decision: "approve", reasons };
  if (annotations.readOnly) return { decision: "allow", reasons: ["tool_read_only"] };
  return { decision: "allow", reasons: ["tool_default_allow"] };
}

export function decideApproval(
  annotations: ToolAnnotations,
  policy: unknown
): ToolPolicyDecision {
  return explainToolPolicy(annotations, policy).decision;
}

export function normalizeConnectionPolicy(value: unknown): {
  deny?: boolean;
  approval?: "default" | "never" | "every_call";
} {
  if (!isObject(value)) return {};
  const result: {
    deny?: boolean;
    approval?: "default" | "never" | "every_call";
  } = {};
  if (typeof value.deny === "boolean") result.deny = value.deny;
  if (
    value.approval === "default" ||
    value.approval === "never" ||
    value.approval === "every_call"
  ) {
    result.approval = value.approval;
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
