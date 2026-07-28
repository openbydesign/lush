import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodeSession, HarnessEvent } from "@lush/code";
import { startCodeSidecar } from "../services/agent/src/code/server";
import { CodeSessionStore } from "../services/agent/src/code/store";

const sidecarEntry = path.join(import.meta.dir, "../services/agent/src/code/sidecar.ts");

/**
 * Launch the sidecar entrypoint the way the desktop shell does, and either wait
 * for its ready line or for it to give up.
 */
async function launchSidecar(options: { argv: string[]; stdin: string; stateDirectory: string }) {
  // Back stdin with a real file rather than a pipe: the entrypoint opens
  // /dev/stdin by name, and reopening an anonymous pipe whose writer has
  // already closed fails with ENXIO.
  const stdinFile = path.join(options.stateDirectory, "stdin");
  await writeFile(stdinFile, options.stdin);
  const stdin = openSync(stdinFile, "r");

  const child = spawn(process.execPath, ["run", sidecarEntry, `--state-dir=${options.stateDirectory}`, "--port=0", ...options.argv], {
    cwd: path.join(import.meta.dir, ".."),
    stdio: [stdin, "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

  return new Promise<{ started: boolean; stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    const finish = (started: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.kill("SIGKILL");
      // Node closes a descriptor handed to stdio once the child is spawned.
      try { closeSync(stdin); } catch {}
      resolve({ started, stdout, stderr });
    };
    // A successful launch prints one ready line and then stays up for signals.
    const poll = setInterval(() => { if (stdout.includes("\n")) finish(true); }, 25);
    const timer = setTimeout(() => finish(stdout.includes("\n")), 15_000);
    child.once("error", (error) => { if (!settled) { settled = true; clearInterval(poll); clearTimeout(timer); reject(error); } });
    child.once("exit", () => finish(stdout.includes("\n")));
  });
}

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

test("local Code sidecar takes its capability token from stdin", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "lush-code-state-"));
  try {
    const launch = await launchSidecar({ argv: [], stdin: "b".repeat(64), stateDirectory });
    expect(launch.started).toBe(true);
    expect(JSON.parse(launch.stdout.split("\n")[0]!)).toMatchObject({ type: "ready" });
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

test("local Code sidecar refuses a capability token passed on argv", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "lush-code-state-"));
  try {
    // argv is world-readable through the process table, so a token supplied
    // that way must not launch a server even though it is otherwise valid.
    const launch = await launchSidecar({ argv: [`--token=${"c".repeat(64)}`], stdin: "", stateDirectory });
    expect(launch.started).toBe(false);
    expect(launch.stdout).not.toContain("ready");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

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
