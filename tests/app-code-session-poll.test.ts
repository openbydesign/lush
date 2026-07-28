import { describe, expect, test } from "bun:test";
import type { CodeSession, EventPage } from "@lush/code";
import {
  applyCodeSessionEventPage,
  createCodeSessionPoll
} from "../apps/lush/src/lib/code-session-poll";

describe("app Code session polling", () => {
  test("preserves a terminal session error from the cursor response", () => {
    const current = session("session-a");
    const page = eventPage({
      status: "failed",
      error: "Harness process exited with code 1"
    });

    expect(applyCodeSessionEventPage(current, current.id, page)).toMatchObject({
      status: "failed",
      error: "Harness process exited with code 1"
    });
  });

  test("ignores a stale response across an A to B to A session switch", async () => {
    let activeSession = session("session-a");
    const staleRequest = Promise.withResolvers<EventPage>();
    const currentRequest = Promise.withResolvers<EventPage>();
    const errors: unknown[] = [];

    const stalePoll = createCodeSessionPoll({
      initialCursor: 0,
      request: () => staleRequest.promise,
      update: (page) => {
        activeSession = applyCodeSessionEventPage(activeSession, "session-a", page)!;
      },
      onError: (reason) => errors.push(reason)
    });
    const staleTick = stalePoll.tick();

    stalePoll.stop();
    activeSession = session("session-b");
    activeSession = session("session-a");

    const currentPoll = createCodeSessionPoll({
      initialCursor: 0,
      request: () => currentRequest.promise,
      update: (page) => {
        activeSession = applyCodeSessionEventPage(activeSession, "session-a", page)!;
      },
      onError: (reason) => errors.push(reason)
    });
    const currentTick = currentPoll.tick();
    const page = eventPage({
      events: [event(1)],
      messages: [message("current response")]
    });

    currentRequest.resolve(page);
    await currentTick;
    staleRequest.resolve(page);
    await staleTick;

    expect(activeSession.events.map(({ sequence }) => sequence)).toEqual([1]);
    expect(activeSession.messages.map(({ content }) => content)).toEqual([
      "current response"
    ]);
    expect(errors).toEqual([]);
  });
});

function session(id: string): CodeSession {
  return {
    id,
    status: "running",
    messages: [],
    events: []
  } as CodeSession;
}

function eventPage(overrides: Partial<EventPage> = {}): EventPage {
  return {
    events: [],
    nextCursor: 0,
    status: "running",
    messages: [],
    ...overrides
  };
}

function event(sequence: number): EventPage["events"][number] {
  return { sequence } as EventPage["events"][number];
}

function message(content: string): EventPage["messages"][number] {
  return { content } as EventPage["messages"][number];
}
