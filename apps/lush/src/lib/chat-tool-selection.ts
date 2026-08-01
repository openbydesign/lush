import type { Session } from "@lush/api-client";

export const chatToolSelectionStateKind = "chat_tool_selection";

export function chatToolSelectionState(
  disabledToolDefinitionIds: Iterable<string>
) {
  return {
    kind: chatToolSelectionStateKind,
    state: {
      version: 1,
      disabledToolDefinitionIds: normalizeToolDefinitionIds(
        disabledToolDefinitionIds
      )
    }
  };
}

export function chatToolSelectionFromSession(session: Session | undefined) {
  for (const snapshot of [...(session?.stateSnapshots ?? [])].reverse()) {
    if (
      snapshot.kind !== chatToolSelectionStateKind ||
      !snapshot.state ||
      typeof snapshot.state !== "object"
    ) {
      continue;
    }

    const disabledToolDefinitionIds = (
      snapshot.state as { disabledToolDefinitionIds?: unknown }
    ).disabledToolDefinitionIds;
    if (!Array.isArray(disabledToolDefinitionIds)) continue;

    return normalizeToolDefinitionIds(
      disabledToolDefinitionIds.filter(
        (id): id is string => typeof id === "string"
      )
    );
  }

  return undefined;
}

function normalizeToolDefinitionIds(ids: Iterable<string>) {
  return [...new Set([...ids].map((id) => id.trim()).filter(Boolean))].sort();
}
