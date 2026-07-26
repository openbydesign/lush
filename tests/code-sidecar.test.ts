import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodeSession, HarnessEvent } from "@lush/code";
import { startCodeSidecar } from "../services/agent/src/code/server";
import { CodeSessionStore } from "../services/agent/src/code/store";

test("local Code sidecar requires its per-launch capability token", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "lush-code-state-"));
  const token = "a".repeat(64);
  const server = startCodeSidecar({ token, stateDirectory });
  const baseUrl = `http://${server.hostname}:${server.port}`;

  try {
    const unauthorized = await fetch(`${baseUrl}/v1/sessions`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual([]);
  } finally {
    server.stop(true);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("event cursor pages the delta and reports the next cursor", async () => {
  await withSeededSidecar(async (poll) => {
    expect(await poll(populated, "0")).toEqual({ sequences: [1, 2, 3], nextCursor: 3 });
    expect(await poll(populated, "2")).toEqual({ sequences: [3], nextCursor: 3 });
    expect(await poll(populated, "3")).toEqual({ sequences: [], nextCursor: 3 });
    expect(await poll(populated, "")).toEqual({ sequences: [1, 2, 3], nextCursor: 3 });
    expect(await poll(empty, "0")).toEqual({ sequences: [], nextCursor: 0 });
  });
});

test("event cursor survives an unusable after parameter", async () => {
  // Number("NaN" | "abc" | "null") is NaN, and every `sequence > NaN` comparison
  // is false, so an unsanitised cursor filters the whole delta away. On a session
  // that has no events yet the cursor is also echoed back as nextCursor, where a
  // non-finite value serialises to null and the poller returns it as ?after=null.
  await withSeededSidecar(async (poll) => {
    for (const unusable of ["NaN", "abc", "null", "undefined", "Infinity", "-Infinity", "1e999"]) {
      expect(await poll(populated, unusable)).toEqual({ sequences: [1, 2, 3], nextCursor: 3 });
      expect(await poll(empty, unusable)).toEqual({ sequences: [], nextCursor: 0 });
    }

    for (const negative of ["-1", "-999"]) {
      expect(await poll(populated, negative)).toEqual({ sequences: [1, 2, 3], nextCursor: 3 });
      expect(await poll(empty, negative)).toEqual({ sequences: [], nextCursor: 0 });
    }

    // A fractional cursor keeps its floor: 1.5 still means "everything after 1".
    expect(await poll(populated, "1.5")).toEqual({ sequences: [2, 3], nextCursor: 3 });
    expect(await poll(empty, "1.5")).toEqual({ sequences: [], nextCursor: 0 });

    // A finite cursor beyond this session's tail is unusable too. Resynchronise
    // immediately instead of allowing it to skip events that are appended later.
    for (const outOfRange of ["999999", "9007199254740991", "1e21"]) {
      expect(await poll(populated, outOfRange)).toEqual({ sequences: [1, 2, 3], nextCursor: 3 });
      expect(await poll(empty, outOfRange)).toEqual({ sequences: [], nextCursor: 0 });
    }
  });
});

test("event cursor cannot poison itself across polls", async () => {
  // The client assigns page.nextCursor straight back into the next request, so a
  // cursor that is not a finite number would repeat forever once it appeared.
  await withSeededSidecar(async (poll) => {
    let cursor: unknown = "NaN";
    for (let tick = 0; tick < 3; tick += 1) {
      const page = await poll(empty, String(cursor));
      expect(Number.isFinite(page.nextCursor)).toBe(true);
      cursor = page.nextCursor;
    }
    expect(cursor).toBe(0);
  });
});

test("event cursor stays live as sessions append after empty and at-tail polls", async () => {
  await withSeededSidecar(async (poll, appendEvent) => {
    const emptyPage = await poll(empty, "999999");
    expect(emptyPage).toEqual({ sequences: [], nextCursor: 0 });

    await appendEvent(empty);
    expect(await poll(empty, String(emptyPage.nextCursor))).toEqual({
      sequences: [1],
      nextCursor: 1
    });

    const atTail = await poll(populated, "3");
    expect(atTail).toEqual({ sequences: [], nextCursor: 3 });

    await appendEvent(populated);
    expect(await poll(populated, String(atTail.nextCursor))).toEqual({
      sequences: [4],
      nextCursor: 4
    });
  });
});

const populated = "11111111-1111-4111-8111-111111111111";
const empty = "22222222-2222-4222-8222-222222222222";

async function withSeededSidecar(
  assertions: (
    poll: (id: string, after: string) => Promise<{ sequences: number[]; nextCursor: unknown }>,
    appendEvent: (id: string) => Promise<void>
  ) => Promise<void>
) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "lush-code-cursor-"));
  const token = "a".repeat(64);
  const store = new CodeSessionStore(stateDirectory);
  await store.put(sessionFixture(populated, 3));
  await store.put(sessionFixture(empty, 0));

  const server = startCodeSidecar({ token, stateDirectory });
  const baseUrl = `http://${server.hostname}:${server.port}`;

  try {
    const poll = async (id: string, after: string) => {
      const response = await fetch(`${baseUrl}/v1/sessions/${id}/events?after=${after}`, {
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.status).toBe(200);
      const page = await response.json() as { events: HarnessEvent[]; nextCursor: unknown };
      return { sequences: page.events.map((event) => event.sequence), nextCursor: page.nextCursor };
    };
    const appendEvent = async (id: string) => {
      const session = await store.get(id);
      if (!session) throw new Error(`Missing cursor fixture ${id}`);
      const sequence = (session.events.at(-1)?.sequence ?? 0) + 1;
      session.events.push({
        id: `event-${sequence}`,
        sequence,
        occurredAt: `2026-07-17T00:00:0${sequence}.000Z`,
        harnessId: "codex",
        externalSessionId: "external-session",
        turnId: "turn-1",
        kind: "turn.started",
        data: { promptMessageId: `prompt-${sequence}` }
      });
      await store.put(session);
    };
    await assertions(poll, appendEvent);
  } finally {
    server.stop(true);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

function sessionFixture(id: string, eventCount: number): CodeSession {
  const events = Array.from({ length: eventCount }, (_, index) => ({
    id: `event-${index}`,
    sequence: index + 1,
    occurredAt: `2026-07-17T00:00:0${index}.000Z`,
    harnessId: "codex",
    externalSessionId: "external-session",
    turnId: "turn-1",
    kind: "message.delta",
    data: { messageId: "assistant", role: "assistant", format: "markdown", delta: `delta-${index}` }
  })) as HarnessEvent[];

  return {
    id,
    title: "Cursor fixture",
    harnessId: "codex",
    status: "running",
    branch: "main",
    repositoryName: "fixture",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:02.000Z",
    archived: false,
    draft: {
      repositoryPath: "/tmp/fixture",
      baseRef: "main",
      harnessId: "codex",
      useWorktree: false,
      autonomy: "accept-edits"
    },
    effectiveAutonomy: "accept-edits",
    workspace: {
      repositoryRoot: "/tmp/fixture",
      path: "/tmp/fixture",
      branch: "main",
      baseRef: "main",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      managedWorktree: false
    },
    binding: {
      harnessId: "codex",
      harnessVersion: "1.0.0",
      adapterVersion: "1.0.0",
      transport: "structured-cli",
      externalSessionId: "external-session"
    },
    messages: [
      { id: "user-1", role: "user", content: "prompt", createdAt: "2026-07-17T00:00:00.000Z", turnId: "turn-1" },
      {
        id: "assistant",
        role: "assistant",
        content: events.map((event) => event.data.delta).join(""),
        createdAt: "2026-07-17T00:00:00.000Z",
        turnId: "turn-1"
      }
    ],
    events
  } as CodeSession;
}
