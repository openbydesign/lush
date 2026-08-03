import { describe, expect, test } from "bun:test";
import {
  InFlightRegistry,
  InMemoryEventLog,
  RemoteIsolationOutputLimitError,
  RemoteIsolationProvider,
  runExec,
  textMessage,
  type EnvironmentSpec,
  type ExecResponse
} from "../services/agent/src/harness";

const token = "remote-isolation-token-that-is-long-enough";

function spec(overrides: Partial<EnvironmentSpec> = {}): EnvironmentSpec {
  return {
    environmentId: crypto.randomUUID(),
    profile: "chat",
    organizationId: "org-1",
    ownerUserId: "user-1",
    sessionId: "session-1",
    harnessId: "echo",
    ...overrides
  };
}

async function collect(generator: AsyncGenerator<ExecResponse>) {
  const frames: ExecResponse[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("RemoteIsolationProvider", () => {
  test("provisions, streams the harness protocol, and destroys by durable identity", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    const runtime = spec();
    const provider = new RemoteIsolationProvider({
      baseUrl: "https://sandbox.internal/control/",
      apiToken: token,
      fetch: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          method: init?.method ?? "GET",
          authorization: headers.get("authorization")
        });
        if (url.endsWith(`/v1/environments/${runtime.environmentId}`)) {
          if (init?.method === "POST") {
            return Response.json({ id: runtime.environmentId });
          }
          return new Response(null, { status: 204 });
        }
        if (url.includes(`/v1/environments/${runtime.environmentId}/turns/`)) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            harnessId: "echo",
            start: { type: "start" }
          });
          const frames = [
            JSON.stringify({
              type: "outputs",
              messages: [textMessage("assistant", "remote: hello")]
            }),
            JSON.stringify({ type: "end", state: "completed" })
          ].join("\n") + "\n";
          return new Response(new ReadableStream({
            start(controller) {
              const bytes = new TextEncoder().encode(frames);
              controller.enqueue(bytes.slice(0, 17));
              controller.enqueue(bytes.slice(17));
              controller.close();
            }
          }), { headers: { "content-type": "application/x-ndjson" } });
        }
        return new Response("missing", { status: 404 });
      }
    });

    const environment = await provider.provision(runtime);
    const output = await collect(runExec({
      request: {
        conversationId: "conversation-1",
        inputs: [textMessage("user", "hello")],
        harnessId: "echo"
      },
      log: new InMemoryEventLog(),
      harness: environment.harness(),
      inFlight: new InFlightRegistry(),
      signal: new AbortController().signal
    }));
    expect(output.at(-1)?.outputs).toEqual([
      textMessage("assistant", "remote: hello")
    ]);
    await environment.destroy();
    expect(calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "DELETE"]);
  });

  test("enforces the output byte limit while consuming a remote stream", async () => {
    const runtime = spec({ limits: { maxOutputBytes: 16 } });
    const provider = new RemoteIsolationProvider({
      baseUrl: "https://sandbox.internal",
      apiToken: token,
      fetch: async (input, init) => {
        if (!String(input).includes("/turns/")) {
          return Response.json({ id: runtime.environmentId });
        }
        return new Response("x".repeat(32), {
          headers: { "content-type": "application/x-ndjson" }
        });
      }
    });
    const environment = await provider.provision(runtime);
    const iterator = environment.harness().connect(
      { messages: [textMessage("user", "too much")] },
      new AbortController().signal
    );
    await expect(async () => {
      for await (const _frame of iterator) {}
    }).toThrow(RemoteIsolationOutputLimitError);
  });

  test("rejects plaintext non-loopback control URLs and weak tokens", () => {
    expect(() => new RemoteIsolationProvider({
      baseUrl: "http://sandbox.example.com",
      apiToken: token
    })).toThrow("must use HTTPS");
    expect(() => new RemoteIsolationProvider({
      baseUrl: "https://sandbox.example.com",
      apiToken: "weak"
    })).toThrow("at least 32 characters");
  });
});
