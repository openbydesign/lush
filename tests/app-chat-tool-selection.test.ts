import { describe, expect, test } from "bun:test";
import type { Session, SessionStateSnapshot } from "@lush/api-client";
import {
  chatToolSelectionFromSession,
  chatToolSelectionState
} from "../apps/lush/src/lib/chat-tool-selection";

function session(stateSnapshots: SessionStateSnapshot[]): Session {
  return {
    id: "session-1",
    organizationId: "org-1",
    ownerUserId: "user-1",
    title: "Test session",
    agentId: "lush-chat",
    projectId: null,
    pinnedAt: null,
    stateBytes: 0,
    version: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    archivedAt: null,
    messages: [],
    stateSnapshots
  };
}

function toolSnapshot(
  id: string,
  disabledToolDefinitionIds: string[]
): SessionStateSnapshot {
  return {
    id,
    sessionId: "session-1",
    ...chatToolSelectionState(disabledToolDefinitionIds),
    byteSize: disabledToolDefinitionIds.join("").length,
    createdAt: `2026-07-31T00:00:0${id.slice(-1)}.000Z`
  };
}

describe("chat tool selection", () => {
  test("persists a normalized session-local deny-list", () => {
    expect(chatToolSelectionState(["tool-b", " tool-a ", "tool-b", ""]))
      .toEqual({
        kind: "chat_tool_selection",
        state: {
          version: 1,
          disabledToolDefinitionIds: ["tool-a", "tool-b"]
        }
      });
  });

  test("rehydrates the newest session selection, including enable-all", () => {
    expect(chatToolSelectionFromSession(session([
      toolSnapshot("state-1", ["tool-a"]),
      toolSnapshot("state-2", [])
    ]))).toEqual([]);
  });

  test("returns undefined when the session has no tool selection", () => {
    expect(chatToolSelectionFromSession(session([]))).toBeUndefined();
  });
});
