import { describe, expect, test } from "bun:test";
import {
  AgentToolTimeoutError,
  scopedToolCallId,
  withToolExecutionTimeout
} from "../services/agent/src/run-executor";

describe("agent tool call ids", () => {
  test("namespaces provider ids by model iteration and call ordinal", async () => {
    const first = await scopedToolCallId("run-1", 0, 0, "web_fetch:0");
    const retry = await scopedToolCallId("run-1", 0, 0, "web_fetch:0");
    const nextTurn = await scopedToolCallId("run-1", 1, 0, "web_fetch:0");
    const parallelCall = await scopedToolCallId("run-1", 0, 1, "web_fetch:0");

    expect(first).toBe(retry);
    expect(first).not.toBe(nextTurn);
    expect(first).not.toBe(parallelCall);
    expect(first).toMatch(/^call_[a-f0-9]{32}$/);
  });
});

describe("agent tool execution timeout", () => {
  test("returns completed tool work before the deadline", async () => {
    const result = await withToolExecutionTimeout(
      async () => "done",
      new AbortController().signal,
      50
    );

    expect(result).toBe("done");
  });

  test("aborts and rejects a stalled tool attempt at the deadline", async () => {
    let childSignal: AbortSignal | undefined;
    const result = withToolExecutionTimeout(
      async (signal) => {
        childSignal = signal;
        return await new Promise<string>(() => {});
      },
      new AbortController().signal,
      10
    );

    await expect(result).rejects.toBeInstanceOf(AgentToolTimeoutError);
    expect(childSignal?.aborted).toBe(true);
  });

  test("propagates cancellation without converting it to a timeout", async () => {
    const parent = new AbortController();
    const reason = new Error("user cancelled");
    const result = withToolExecutionTimeout(
      async () => await new Promise<string>(() => {}),
      parent.signal,
      1_000
    );
    parent.abort(reason);

    await expect(result).rejects.toBe(reason);
  });
});
