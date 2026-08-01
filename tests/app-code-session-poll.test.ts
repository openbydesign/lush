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
        activeSession = applyCodeSessionEventPage(
          activeSession,
          "session-a",
          page
        )!;
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
        activeSession = applyCodeSessionEventPage(
          activeSession,
          "session-a",
          page
        )!;
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

  test("reseeds polling after a concurrent same-session reload", async () => {
    let activeSession = session("session-a", [event(10)]);
    const staleRequest = Promise.withResolvers<EventPage>();
    const currentRequest = Promise.withResolvers<EventPage>();
    const requestedCursors: number[] = [];
    const errors: unknown[] = [];

    const stalePoll = createCodeSessionPoll({
      initialCursor: activeSession.events.at(-1)?.sequence ?? 0,
      request: (cursor) => {
        requestedCursors.push(cursor);
        return staleRequest.promise;
      },
      update: (page) => {
        activeSession = applyCodeSessionEventPage(
          activeSession,
          "session-a",
          page
        )!;
      },
      onError: (reason) => errors.push(reason)
    });
    const staleTick = stalePoll.tick();

    // A same-ID full-session reload replaces the event list while the old
    // cursor request is still in flight. The provider must stop that poll
    // generation and start a new one seeded from the replacement session.
    stalePoll.stop();
    activeSession = session("session-a", [event(3), event(4)]);

    const currentPoll = createCodeSessionPoll({
      initialCursor: activeSession.events.at(-1)?.sequence ?? 0,
      request: (cursor) => {
        requestedCursors.push(cursor);
        return currentRequest.promise;
      },
      update: (page) => {
        activeSession = applyCodeSessionEventPage(
          activeSession,
          "session-a",
          page
        )!;
      },
      onError: (reason) => errors.push(reason)
    });
    const currentTick = currentPoll.tick();

    currentRequest.resolve(eventPage({
      events: [event(5)],
      nextCursor: 5,
      messages: [message("replacement delta")]
    }));
    await currentTick;

    staleRequest.resolve(eventPage({
      events: [event(11)],
      nextCursor: 11,
      messages: [message("stale delta")]
    }));
    await staleTick;

    expect(requestedCursors).toEqual([10, 4]);
    expect(activeSession.events.map(({ sequence }) => sequence)).toEqual([
      3,
      4,
      5
    ]);
    expect(activeSession.messages.map(({ content }) => content)).toEqual([
      "replacement delta"
    ]);
    expect(errors).toEqual([]);
  });
});

function session(id: string, events: EventPage["events"] = []): CodeSession {
  return {
    id,
    status: "running",
    messages: [],
    events
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
