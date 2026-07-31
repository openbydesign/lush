import { describe, expect, test } from "bun:test";
import type { ToolResult } from "../services/tools/src/connectors/types";
import { coalesceBrokerDeltas } from "../services/agent/src/harness/harnesses";
import {
  ConversationBusyError,
  AmbiguousToolOutcomeError,
  HarnessExecutionError,
  HarnessProtocolError,
  HarnessResolutionError,
  InFlightRegistry,
  InMemoryEventLog,
  createGatewayExecutor,
  echoHarness,
  resumptionState,
  runExec,
  textMessage,
  toolCallingHarness,
  toolResultContentFromResult,
  type ConversationEvent,
  type ExecResponse,
  type Harness,
  type HarnessResponse,
  type ToolCallContent
} from "../services/agent/src/harness";

const signal = () => new AbortController().signal;

async function collect(gen: AsyncGenerator<ExecResponse>): Promise<ExecResponse[]> {
  const frames: ExecResponse[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function scriptedHarness(id: string, script: (req: { messages: unknown }, s: AbortSignal) => AsyncIterable<HarnessResponse>): Harness {
  return { id, connect: (req, s) => script(req, s) };
}

describe("event log", () => {
  test("assigns monotonic 1-based steps per conversation", async () => {
    const log = new InMemoryEventLog();
    const s1 = await log.append({
      conversationId: "c1", execId: "e", harnessId: "h", kind: "input",
      messages: [textMessage("user", "hi")], state: "pending"
    });
    const s2 = await log.append({
      conversationId: "c1", execId: "e", harnessId: "h", kind: "output",
      messages: [textMessage("assistant", "yo")], state: "pending"
    });
    const other = await log.append({
      conversationId: "c2", execId: "e", harnessId: "h", kind: "input",
      messages: [], state: "pending"
    });
    expect([s1, s2, other]).toEqual([1, 2, 1]);
    expect((await log.events("c1")).map((e) => e.step)).toEqual([1, 2]);
  });
});

describe("brokered Lush harness", () => {
  test("emits the first delta immediately and coalesces a burst", async () => {
    async function* burst() {
      yield "first";
      yield " ";
      yield "second";
      yield " ";
      yield "third";
    }
    const deltas: string[] = [];
    for await (const delta of coalesceBrokerDeltas(burst())) deltas.push(delta);
    expect(deltas).toEqual(["first", " second third"]);
  });
});

describe("resumptionState", () => {
  const base = { conversationId: "c", execId: "e", harnessId: "h", messages: [] };
  test("empty log has no state", () => {
    expect(resumptionState([])).toEqual({
      currentState: null,
      boundHarnessId: null,
      lastStep: 0,
      needsResume: false,
      needsAcknowledgment: false
    });
  });
  test("a pending tail needs resume; binding is sticky", () => {
    const events: ConversationEvent[] = [
      { ...base, step: 1, kind: "input", state: "pending" }
    ];
    const state = resumptionState(events);
    expect(state.needsResume).toBe(true);
    expect(state.boundHarnessId).toBe("h");
    expect(state.lastStep).toBe(1);
  });
  test("a completed tail does not need resume", () => {
    const events: ConversationEvent[] = [
      { ...base, step: 1, kind: "input", state: "pending" },
      { ...base, step: 2, kind: "completion", state: "completed" }
    ];
    expect(resumptionState(events).needsResume).toBe(false);
    expect(resumptionState(events).currentState).toBe("completed");
  });
});

describe("orchestrator runExec", () => {
  const setup = (harness: Harness) => ({
    log: new InMemoryEventLog(),
    inFlight: new InFlightRegistry(),
    harness
  });

  test("drives a turn and records input, output, and completion events", async () => {
    const { log, inFlight, harness } = setup(echoHarness("h"));
    const frames = await collect(
      runExec({
        request: { conversationId: "c1", inputs: [textMessage("user", "hello")] },
        log, harness, inFlight, signal: signal()
      })
    );
    expect(frames).toEqual([{ outputs: [textMessage("assistant", "echo: hello")], step: 2 }]);

    const events = await log.events("c1");
    expect(events.map((e) => e.kind)).toEqual(["input", "output", "completion"]);
    expect(events.at(-1)!.state).toBe("completed");
  });

  test("enforces one in-flight execution per conversation", async () => {
    const { log, inFlight, harness } = setup(echoHarness("h"));
    const release = inFlight.acquire("c1");
    try {
      await expect(
        collect(
          runExec({
            request: { conversationId: "c1", inputs: [textMessage("user", "x")] },
            log, harness, inFlight, signal: signal()
          })
        )
      ).rejects.toBeInstanceOf(ConversationBusyError);
    } finally {
      release();
    }
    // Lock is released; a subsequent run succeeds.
    const frames = await collect(
      runExec({
        request: { conversationId: "c1", inputs: [textMessage("user", "again")] },
        log, harness, inFlight, signal: signal()
      })
    );
    expect(frames).toHaveLength(1);
  });

  test("rejects resuming with a different harness (sticky binding)", async () => {
    const { log, inFlight } = setup(echoHarness("h"));
    await collect(
      runExec({
        request: { conversationId: "c1", inputs: [textMessage("user", "hi")] },
        log, harness: echoHarness("h"), inFlight, signal: signal()
      })
    );
    await expect(
      collect(
        runExec({
          request: { conversationId: "c1", inputs: [textMessage("user", "hi")] },
          log, harness: echoHarness("other"), inFlight, signal: signal()
        })
      )
    ).rejects.toBeInstanceOf(HarnessResolutionError);
  });

  test("resumes an interrupted (pending-tail) turn by re-running its inputs", async () => {
    const { log, inFlight, harness } = setup(echoHarness("h"));
    // Simulate a crash after inputs were recorded but before any completion.
    await log.append({
      conversationId: "c1", execId: "e0", harnessId: "h", kind: "input",
      messages: [textMessage("user", "resume me")], state: "pending"
    });
    const frames = await collect(
      runExec({
        request: { conversationId: "c1", inputs: [] },
        log, harness, inFlight, signal: signal()
      })
    );
    expect(frames[0]!.outputs).toEqual([textMessage("assistant", "echo: resume me")]);
    expect((await log.events("c1")).at(-1)!.state).toBe("completed");
  });

  test("resume closes the interrupted turn and does not duplicate its outputs", async () => {
    const { log, inFlight, harness } = setup(echoHarness("h"));
    // Simulate a crash mid-turn: input plus one partial output, no completion.
    await log.append({
      conversationId: "c1", execId: "exec0", harnessId: "h", kind: "input",
      messages: [textMessage("user", "resume me")], state: "pending"
    });
    await log.append({
      conversationId: "c1", execId: "exec0", harnessId: "h", kind: "output",
      messages: [textMessage("assistant", "partial")], state: "pending"
    });

    // Reconnect requesting catch-up (lastStep) AND triggering resume (no inputs).
    const frames = await collect(
      runExec({
        request: { conversationId: "c1", inputs: [], lastStep: 0 },
        log, harness, inFlight, signal: signal()
      })
    );
    // Catch-up must not replay the interrupted turn's partial output; only the
    // re-run's fresh output is emitted (no duplication).
    expect(frames.map((f) => f.outputs)).toEqual([
      [textMessage("assistant", "echo: resume me")]
    ]);

    const events = await log.events("c1");
    const exec0Completion = events.find(
      (e) => e.execId === "exec0" && e.kind === "completion"
    );
    expect(exec0Completion?.state).toBe("canceled");
    expect(events.at(-1)!.state).toBe("completed");
  });

  test("does not re-run an interrupted turn after a tool call was emitted", async () => {
    const { log, inFlight, harness } = setup(echoHarness("h"));
    await log.append({
      conversationId: "c1",
      execId: "exec0",
      harnessId: "h",
      kind: "input",
      messages: [textMessage("user", "mutate")],
      state: "pending"
    });
    await log.append({
      conversationId: "c1",
      execId: "exec0",
      harnessId: "h",
      kind: "output",
      messages: [
        {
          role: "assistant",
          content: { type: "tool_call", id: "call-1", name: "mutate", arguments: {} }
        }
      ],
      state: "pending"
    });

    expect(resumptionState(await log.events("c1"))).toMatchObject({
      needsResume: false,
      needsAcknowledgment: true
    });
    await expect(
      collect(
        runExec({
          request: { conversationId: "c1", inputs: [] },
          log,
          harness,
          inFlight,
          signal: signal()
        })
      )
    ).rejects.toBeInstanceOf(AmbiguousToolOutcomeError);
    expect(await log.events("c1")).toHaveLength(2);
  });

  test("abandoning iteration early still terminates the turn and frees the lock", async () => {
    const multi = scriptedHarness("h", async function* () {
      yield { type: "outputs", messages: [textMessage("assistant", "one")] };
      yield { type: "outputs", messages: [textMessage("assistant", "two")] };
      yield { type: "end", state: "completed" };
    });
    const { log, inFlight, harness } = setup(multi);
    const gen = runExec({
      request: { conversationId: "c1", inputs: [textMessage("user", "go")] },
      log, harness, inFlight, signal: signal()
    });

    const first = await gen.next();
    expect(first.value).toEqual({ outputs: [textMessage("assistant", "one")], step: 2 });
    // Consumer stops early (what `break` in a `for await` does).
    await gen.return(undefined);

    const events = await log.events("c1");
    expect(events.at(-1)!.kind).toBe("completion");
    expect(events.at(-1)!.state).toBe("canceled");
    expect(inFlight.isActive("c1")).toBe(false);
  });

  test("catches a reconnecting client up via lastStep without re-running", async () => {
    const { log, inFlight, harness } = setup(echoHarness("h"));
    await collect(
      runExec({
        request: { conversationId: "c1", inputs: [textMessage("user", "hi")] },
        log, harness, inFlight, signal: signal()
      })
    );
    const eventsAfterFirst = await log.events("c1");

    // Reconnect: no new inputs, replay everything after step 0.
    const frames = await collect(
      runExec({
        request: { conversationId: "c1", inputs: [], lastStep: 0 },
        log, harness, inFlight, signal: signal()
      })
    );
    expect(frames).toEqual([{ outputs: [textMessage("assistant", "echo: hi")], step: 2 }]);
    // No new events were appended by the catch-up.
    expect((await log.events("c1")).length).toBe(eventsAfterFirst.length);
  });

  test("surfaces a failed end frame as HarnessExecutionError", async () => {
    const failing = scriptedHarness("h", async function* () {
      yield { type: "end", state: "failed", error: { code: 13, description: "boom" } };
    });
    const { log, inFlight, harness } = setup(failing);
    await expect(
      collect(
        runExec({
          request: { conversationId: "c1", inputs: [textMessage("user", "x")] },
          log, harness, inFlight, signal: signal()
        })
      )
    ).rejects.toBeInstanceOf(HarnessExecutionError);
    expect((await log.events("c1")).at(-1)!.state).toBe("failed");
  });

  test("treats a stream that ends without an end frame as a protocol error", async () => {
    const noEnd = scriptedHarness("h", async function* () {
      yield { type: "outputs", messages: [textMessage("assistant", "partial")] };
    });
    const { log, inFlight, harness } = setup(noEnd);
    await expect(
      collect(
        runExec({
          request: { conversationId: "c1", inputs: [textMessage("user", "x")] },
          log, harness, inFlight, signal: signal()
        })
      )
    ).rejects.toBeInstanceOf(HarnessProtocolError);
    expect((await log.events("c1")).at(-1)!.state).toBe("failed");
  });

  test("cancellation records a canceled completion and stops cleanly", async () => {
    const cancelable = scriptedHarness("h", async function* (_req, s) {
      yield { type: "outputs", messages: [textMessage("assistant", "working")] };
      if (s.aborted) throw new Error("aborted");
      yield { type: "end", state: "completed" };
    });
    const { log, inFlight, harness } = setup(cancelable);
    const controller = new AbortController();
    const gen = runExec({
      request: { conversationId: "c1", inputs: [textMessage("user", "go")] },
      log, harness, inFlight, signal: controller.signal
    });
    const first = await gen.next();
    expect(first.value).toEqual({ outputs: [textMessage("assistant", "working")], step: 2 });
    controller.abort();
    const second = await gen.next();
    expect(second.done).toBe(true);
    expect((await log.events("c1")).at(-1)!.state).toBe("canceled");
    // The single-writer lock was released even though the turn was canceled.
    expect(inFlight.isActive("c1")).toBe(false);
  });
});

describe("tool gateway bridge", () => {
  const call: ToolCallContent = {
    type: "tool_call", id: "call-1", name: "current_time", arguments: { timeZone: "UTC" }
  };

  test("maps a gateway ToolResult into a correlated ToolResultContent", () => {
    const result: ToolResult = {
      isError: false,
      content: [{ type: "json", data: { iso: "2026-07-29T00:00:00Z" } }],
      structured: { iso: "2026-07-29T00:00:00Z" }
    };
    expect(toolResultContentFromResult(call, result)).toEqual({
      type: "tool_result",
      callId: "call-1",
      name: "current_time",
      isError: false,
      response: { iso: "2026-07-29T00:00:00Z" },
      signature: undefined
    });
  });

  test("executor turns a gateway failure into an error tool result", async () => {
    const executor = createGatewayExecutor({
      runId: "run-1",
      resolveBinding: async () => ({ connectionId: "connection-1", definitionDigest: "digest-1" }),
      invoke: async () => {
        throw new Error("connection_disabled");
      }
    });
    const result = await executor.execute(call, signal());
    expect(result.isError).toBe(true);
    expect(result.response).toEqual({ error: "connection_disabled" });
  });

  test("a tool-calling harness flows tool_call and tool_result through the log", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const executor = createGatewayExecutor({
      runId: "run-1",
      resolveBinding: async () => ({ connectionId: "connection-1", definitionDigest: "digest-1" }),
      invoke: async (params) => {
        seen.push(params);
        return {
          isError: false,
          content: [{ type: "text", text: "ok" }],
          structured: { echoed: params.arguments, tool: params.name }
        };
      }
    });
    const runtime = toolCallingHarness({ id: "h", executor, toolName: "current_time" });
    const log = new InMemoryEventLog();
    const frames = await collect(
      runExec({
        request: { conversationId: "c1", inputs: [textMessage("user", "time?")] },
        log,
        harness: runtime,
        inFlight: new InFlightRegistry(),
        signal: signal()
      })
    );
    // outputs: tool_call, tool_result, assistant summary
    expect(frames).toHaveLength(3);
    const contentTypes = frames.map((f) => f.outputs[0]!.content.type);
    expect(contentTypes).toEqual(["tool_call", "tool_result", "text"]);
    expect(seen[0]).toMatchObject({
      connectionId: "connection-1",
      expectedDefinitionDigest: "digest-1",
      runId: "run-1",
      name: "current_time"
    });
    expect(seen[0]!.idempotencyKey).toBe(`run-1:${seen[0]!.callId}`);

    const events = await log.events("c1");
    const toolResultEvent = events.find(
      (e) => e.kind === "output" && e.messages[0]?.content.type === "tool_result"
    );
    expect(toolResultEvent).toBeDefined();
  });
});
