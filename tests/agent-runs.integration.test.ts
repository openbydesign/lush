import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { closeDb, createDb, getDb } from "../packages/db/src/client";
import { migrateToLatest } from "../packages/db/src/migrate";
import { createInferenceProvider } from "../services/inference/src/runtime";
import { decideToolApproval } from "../services/tools/src/gateway";
import {
  executeAgentRun,
  nextBrokerEventOrHeartbeat
} from "../services/agent/src/run-executor";
import {
  cancelAgentRun,
  createAgentRun,
  listAgentRunEvents,
  parseRunConfiguration,
  type AgentRunPrincipal
} from "../services/agent/src/runs";
import {
  appendSessionState,
  createSession,
  truncateSession
} from "../services/sessions/src/runtime";
import { integrationDatabaseUrl } from "./integration-database";

const databaseUrl = integrationDatabaseUrl();

if (!databaseUrl) {
  test.skip("durable agent runs require a test database URL", () => {});
} else {
  describe("durable agent runs", () => {
    let schemaName: string;
    let adminDb: ReturnType<typeof createDb>;
    let previousDatabaseUrl: string | undefined;
    let previousSecretKey: string | undefined;

    beforeAll(async () => {
      previousDatabaseUrl = process.env.DATABASE_URL;
      previousSecretKey = process.env.LUSH_SECRET_KEY;
      process.env.LUSH_SECRET_KEY = "durable-run-test-secret";
      schemaName = `test_${crypto.randomUUID().replace(/-/g, "")}`;
      adminDb = createDb({ databaseUrl });
      await sql`create schema ${sql.ref(schemaName)}`.execute(adminDb);
      const schemaUrl = new URL(databaseUrl);
      schemaUrl.searchParams.set("options", `-c search_path=${schemaName}`);
      process.env.DATABASE_URL = schemaUrl.toString();
      await closeDb();
      await migrateToLatest(getDb());
    });

    afterAll(async () => {
      await closeDb();
      await sql`drop schema if exists ${sql.ref(schemaName)} cascade`.execute(adminDb);
      await adminDb.destroy();
      restoreEnv("DATABASE_URL", previousDatabaseUrl);
      restoreEnv("LUSH_SECRET_KEY", previousSecretKey);
    });

    test("the inference broker keeps an approval wait alive with heartbeats", async () => {
      let resolve!: (result: IteratorResult<string>) => void;
      const pending = new Promise<IteratorResult<string>>((done) => {
        resolve = done;
      });
      expect(await nextBrokerEventOrHeartbeat(pending, 1)).toEqual({
        kind: "heartbeat"
      });
      resolve({ done: false, value: "approved" });
      expect(await nextBrokerEventOrHeartbeat(pending, 1)).toEqual({
        kind: "event",
        result: { done: false, value: "approved" }
      });
    });

    test("creates one atomic origin message and replays exact idempotent starts", async () => {
      const { principal, sessionId } = await seedSession();
      const request = {
        idempotencyKey: "turn-1",
        modelSelection: "test:model",
        message: { role: "user" as const, content: "Hello durable world" },
        metadata: { schema: "test" }
      };

      const first = await createAgentRun(principal, sessionId, request);
      const replay = await createAgentRun(principal, sessionId, request);

      expect(first.created).toBe(true);
      expect(replay).toMatchObject({ created: false, run: { id: first.run.id } });
      expect(await getDb().selectFrom("sessionMessages").select("id")
        .where("threadId", "=", sessionId).execute()).toHaveLength(1);
      expect(await getDb().selectFrom("agentRuns").select("id")
        .where("sessionId", "=", sessionId).execute()).toHaveLength(1);
      const thread = await getDb().selectFrom("sessionThreads")
        .select(["currentRunId", "agentInstallationId", "agentRevisionId"])
        .where("id", "=", sessionId).executeTakeFirstOrThrow();
      expect(thread.currentRunId).toBe(first.run.id);
      expect(thread.agentInstallationId).toBeTruthy();
      expect(thread.agentRevisionId).toBe(first.run.agentRevisionId);
    });

    test("snapshots the session's enabled tools into the run capability", async () => {
      const { principal, sessionId } = await seedSession();
      await getDb().updateTable("organizations")
        .set({ toolGatewayEnabled: true, updatedAt: new Date() })
        .where("id", "=", principal.organizationId)
        .execute();
      const now = new Date();
      const connection = await getDb().insertInto("toolConnections").values({
        organizationId: principal.organizationId,
        ownerUserId: null,
        source: "openapi",
        systemKey: null,
        label: "Web Search",
        endpointConfig: { url: "https://example.com/openapi.json" },
        credentialMode: "none",
        enabled: true,
        policy: { approval: "never" },
        catalogVersion: "v1",
        catalogAcknowledgedVersion: "v1",
        catalogChanged: false,
        healthStatus: "healthy",
        healthCheckedAt: now,
        healthErrorCode: null,
        createdAt: now,
        updatedAt: now
      }).returning("id").executeTakeFirstOrThrow();
      const definitions = await getDb().insertInto("toolDefinitions").values([
        {
          connectionId: connection.id,
          externalName: "web_search",
          qualifiedName: "web_search__web_search",
          title: "Search the web",
          description: "Find current information",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"]
          },
          outputSchema: null,
          annotations: {
            readOnly: true,
            destructive: false,
            idempotent: true,
            openWorld: true
          },
          sourceMetadata: {},
          definitionDigest: "search-digest",
          enabled: true,
          timeoutMs: 60_000,
          createdAt: now,
          updatedAt: now
        },
        {
          connectionId: connection.id,
          externalName: "web_fetch",
          qualifiedName: "web_search__web_fetch",
          title: "Fetch a page",
          description: "Fetch one URL",
          inputSchema: { type: "object" },
          outputSchema: null,
          annotations: {
            readOnly: true,
            destructive: false,
            idempotent: true,
            openWorld: true
          },
          sourceMetadata: {},
          definitionDigest: "fetch-digest",
          enabled: true,
          createdAt: now,
          updatedAt: now
        }
      ]).returning(["id", "externalName"]).execute();
      const disabled = definitions.find((definition) =>
        definition.externalName === "web_fetch"
      )!;
      await appendSessionState(principal, sessionId, {
        kind: "chat_tool_selection",
        state: { version: 1, disabledToolDefinitionIds: [disabled.id] }
      });

      const created = await createAgentRun(
        principal,
        sessionId,
        runRequest("tools", "What happened today?")
      );
      const capability = await getDb().selectFrom("agentRunCapabilities")
        .select("snapshot")
        .where("runId", "=", created.run.id)
        .executeTakeFirstOrThrow();
      expect(capability.snapshot).toMatchObject({
        tools: [{
          connectionId: connection.id,
          connectionLabel: "Web Search",
          connectionSource: "openapi",
          connectionIconUrl: "https://example.com/favicon.ico",
          externalName: "web_search",
          name: "web_search__web_search",
          definitionDigest: "search-digest",
          timeoutMs: 60_000
        }]
      });
    });

    test("rejects idempotency reuse with a different request", async () => {
      const { principal, sessionId } = await seedSession();
      await createAgentRun(principal, sessionId, runRequest("same-key", "first"));
      await expect(createAgentRun(
        principal,
        sessionId,
        runRequest("same-key", "different")
      )).rejects.toMatchObject({ code: "idempotency_mismatch", status: 409 });
    });

    test("prevents history mutation while a run is active", async () => {
      const { principal, sessionId } = await seedSession();
      await createAgentRun(principal, sessionId, runRequest("active", "hold"));
      await expect(truncateSession(principal, sessionId, { afterMessageId: null }))
        .rejects.toMatchObject({ code: "session_run_in_progress", status: 409 });
    });

    test("binds access to the owning organization member", async () => {
      const { principal, sessionId } = await seedSession();
      const created = await createAgentRun(principal, sessionId, runRequest("owner", "secret"));
      const outsider = await seedPrincipal();

      await expect(listAgentRunEvents(outsider, created.run.id))
        .rejects.toMatchObject({ code: "run_not_found", status: 404 });
      await expect(cancelAgentRun(outsider, created.run.id))
        .rejects.toMatchObject({ code: "run_not_found", status: 404 });
    });

    test("cancellation revokes the run and durably saves streamed partial output", async () => {
      const { principal, sessionId } = await seedSession();
      const created = await createAgentRun(principal, sessionId, runRequest("cancel", "go"));
      const now = new Date();
      await getDb().insertInto("agentRunEvents").values([
        {
          runId: created.run.id,
          organizationId: principal.organizationId,
          sequence: 2,
          type: "conversation",
          payload: { type: "input" },
          createdAt: now
        },
        {
          runId: created.run.id,
          organizationId: principal.organizationId,
          sequence: 3,
          type: "text-delta",
          payload: { delta: "partial answer" },
          createdAt: now
        }
      ]).execute();

      const cancelled = await cancelAgentRun(principal, created.run.id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.assistantMessageId).toBeTruthy();
      const capability = await getDb().selectFrom("agentRunCapabilities")
        .select("revokedAt").where("runId", "=", created.run.id)
        .executeTakeFirstOrThrow();
      expect(capability.revokedAt).toBeTruthy();
      const assistant = await getDb().selectFrom("sessionMessages")
        .select(["content", "metadata"])
        .where("id", "=", cancelled.assistantMessageId!).executeTakeFirstOrThrow();
      expect(assistant.content).toBe("partial answer");
      expect(assistant.metadata).toMatchObject({ partial: true, runId: created.run.id });
      const publicEvents = await listAgentRunEvents(principal, created.run.id, 1);
      expect(publicEvents.map((event) => event.type)).toEqual([
        "text-delta",
        "run-status",
        "response-complete"
      ]);
      expect(publicEvents.every((event) => event.type !== "conversation")).toBe(true);
    });

    test("a later run may reuse the retained user origin without duplicating it", async () => {
      const { principal, sessionId } = await seedSession();
      const first = await createAgentRun(principal, sessionId, runRequest("first", "retry me"));
      await cancelAgentRun(principal, first.run.id);
      const second = await createAgentRun(principal, sessionId, {
        ...runRequest("second", "retry me"),
        originMessageId: first.run.originMessageId
      });

      expect(second.run.originMessageId).toBe(first.run.originMessageId);
      expect(await getDb().selectFrom("sessionMessages").select("id")
        .where("threadId", "=", sessionId)
        .where("role", "=", "user").execute()).toHaveLength(1);
      const configuration = parseRunConfiguration(
        (await getDb().selectFrom("agentRuns").select("configuration")
          .where("id", "=", second.run.id).executeTakeFirstOrThrow()).configuration
      );
      expect(configuration.messages).toEqual([{ role: "user", content: "retry me" }]);
    });

    test("rejects reusing an origin that is no longer the active message boundary", async () => {
      const { principal, sessionId } = await seedSession();
      const first = await createAgentRun(principal, sessionId, runRequest("one", "first"));
      await cancelAgentRun(principal, first.run.id);
      const second = await createAgentRun(principal, sessionId, runRequest("two", "second"));
      await cancelAgentRun(principal, second.run.id);

      await expect(createAgentRun(principal, sessionId, {
        ...runRequest("three", "first"),
        originMessageId: first.run.originMessageId
      })).rejects.toMatchObject({ code: "invalid_origin_message", status: 409 });
    });

    test("recovery finalizes an already-completed harness turn without invoking it twice", async () => {
      const { principal, sessionId } = await seedSession();
      const created = await createAgentRun(principal, sessionId, runRequest("recover", "go"));
      const now = new Date();
      const baseEvent = {
        conversationId: created.run.id,
        execId: created.run.id,
        harnessId: "lush-brokered"
      };
      await getDb().insertInto("agentRunEvents").values([
        {
          runId: created.run.id,
          organizationId: principal.organizationId,
          sequence: 2,
          type: "conversation",
          payload: {
            ...baseEvent,
            kind: "input",
            messages: [{ role: "user", content: { type: "text", text: "go" } }],
            state: "pending"
          },
          createdAt: now
        },
        {
          runId: created.run.id,
          organizationId: principal.organizationId,
          sequence: 3,
          type: "conversation",
          payload: {
            ...baseEvent,
            kind: "output",
            messages: [{ role: "assistant", content: { type: "text", text: "recovered" } }],
            state: "pending"
          },
          createdAt: now
        },
        {
          runId: created.run.id,
          organizationId: principal.organizationId,
          sequence: 4,
          type: "conversation",
          payload: { ...baseEvent, kind: "completion", messages: [], state: "completed" },
          createdAt: now
        }
      ]).execute();
      await getDb().updateTable("agentRuns").set({
        status: "running",
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 1_000),
        startedAt: now,
        updatedAt: now
      }).where("id", "=", created.run.id).execute();

      await executeAgentRun(created.run.id);

      const run = await getDb().selectFrom("agentRuns")
        .select(["status", "assistantMessageId"])
        .where("id", "=", created.run.id).executeTakeFirstOrThrow();
      expect(run.status).toBe("completed");
      const assistant = await getDb().selectFrom("sessionMessages").select("content")
        .where("id", "=", run.assistantMessageId!).executeTakeFirstOrThrow();
      expect(assistant.content).toBe("recovered");
      expect(await getDb().selectFrom("sessionMessages").select("id")
        .where("threadId", "=", sessionId).where("role", "=", "assistant")
        .execute()).toHaveLength(1);
    });

    test("executes through the subprocess harness and persists the response before completion", async () => {
      const requests: Array<Record<string, unknown>> = [];
      const providerServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          if (pathname === "/models") {
            return Response.json({ data: [{ id: "durable-model", name: "Durable Model" }] });
          }
          if (pathname === "/chat/completions") {
            requests.push(await request.json() as Record<string, unknown>);
            return new Response([
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Durable " } }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}`,
              "data: [DONE]",
              ""
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
          }
          return new Response(null, { status: 404 });
        }
      });
      try {
        const { principal, sessionId } = await seedSession();
        const provider = await createInferenceProvider(principal.organizationId, {
          kind: "openai-compatible",
          label: "Durable provider",
          apiKey: "provider-secret",
          baseUrl: `http://127.0.0.1:${providerServer.port}`
        });
        await getDb().updateTable("inferenceProviderModels").set({ enabled: true })
          .where("providerId", "=", provider.id).execute();
        const created = await createAgentRun(principal, sessionId, {
          ...runRequest("execute", "Please answer"),
          modelSelection: `${provider.id}:durable-model`
        });

        await executeAgentRun(created.run.id);

        const run = await getDb().selectFrom("agentRuns").selectAll()
          .where("id", "=", created.run.id).executeTakeFirstOrThrow();
        expect(run.status).toBe("completed");
        expect(run.assistantMessageId).toBeTruthy();
        const assistant = await getDb().selectFrom("sessionMessages")
          .select("content").where("id", "=", run.assistantMessageId!)
          .executeTakeFirstOrThrow();
        expect(assistant.content).toBe("Durable answer");
        const events = await listAgentRunEvents(principal, run.id);
        expect(events.map((event) => event.type)).toEqual([
          "run-start",
          "run-status",
          "response-start",
          "text-delta",
          "text-delta",
          "run-status",
          "response-complete"
        ]);
        expect(events.find((event) => event.type === "text-delta")?.payload)
          .toMatchObject({ firstTokenMs: expect.any(Number) });
        expect(requests.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(requests[0])).not.toContain("provider-secret");
        const providerMessages = requests[0]?.messages as Array<{ role?: unknown; content?: unknown }>;
        expect(providerMessages[0]).toMatchObject({
          role: "system",
          content: expect.stringContaining("You are Lush")
        });
      } finally {
        providerServer.stop(true);
      }
    });

    test("pauses for tool approval, invokes through the gateway, and returns the result to the model", async () => {
      const requests: Array<Record<string, unknown>> = [];
      let toolInvocations = 0;
      const providerServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          if (pathname === "/models") {
            return Response.json({ data: [{ id: "tool-model", name: "Tool Model" }] });
          }
          if (pathname === "/air-quality") {
            toolInvocations += 1;
            return Response.json({ location: "Sonoma", aqi: 87, cause: "wildfire smoke" });
          }
          if (pathname !== "/chat/completions") return new Response(null, { status: 404 });
          const body = await request.json() as Record<string, unknown>;
          requests.push(body);
          if (!Array.isArray(body.tools)) {
            return sse([{ choices: [{ delta: { content: "Air quality" } }] }]);
          }
          const messages = body.messages as Array<{ role?: unknown }>;
          if (messages.some((message) => message.role === "tool")) {
            return sse([{ choices: [{ delta: { content: "Air quality checked." } }] }]);
          }
          return sse([
            {
              choices: [{ delta: { tool_calls: [{
                index: 0,
                id: "call-weather",
                type: "function",
                function: { name: "builtin__air_quality", arguments: "" }
              }] } }]
            },
            {
              choices: [{ delta: { tool_calls: [{
                index: 0,
                id: "call-weather",
                function: {
                  arguments: "{\"query\":{\"location\":\"Sonoma\"}}"
                }
              }] } }]
            }
          ]);
        }
      });
      try {
        const { principal, sessionId } = await seedSession();
        await getDb().updateTable("organizations")
          .set({ toolGatewayEnabled: true, updatedAt: new Date() })
          .where("id", "=", principal.organizationId)
          .execute();
        const now = new Date();
        const connection = await getDb().insertInto("toolConnections").values({
          organizationId: principal.organizationId,
          ownerUserId: null,
          source: "openapi",
          systemKey: null,
          label: "Built-in",
          endpointConfig: {
            url: `http://127.0.0.1:${providerServer.port}/openapi.json`
          },
          credentialMode: "none",
          enabled: true,
          policy: {},
          catalogVersion: "v1",
          catalogAcknowledgedVersion: "v1",
          catalogChanged: false,
          healthStatus: "healthy",
          healthCheckedAt: now,
          healthErrorCode: null,
          createdAt: now,
          updatedAt: now
        }).returning("id").executeTakeFirstOrThrow();
        await getDb().insertInto("toolDefinitions").values({
          connectionId: connection.id,
          externalName: "air_quality",
          qualifiedName: "builtin__air_quality",
          title: "Air quality",
          description: "Look up current air quality",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "object",
                properties: { location: { type: "string" } },
                required: ["location"],
                additionalProperties: false
              }
            },
            additionalProperties: false
          },
          outputSchema: null,
          annotations: {
            readOnly: true,
            destructive: false,
            idempotent: true,
            openWorld: true
          },
          sourceMetadata: {
            method: "GET",
            path: "/air-quality",
            baseUrl: `http://127.0.0.1:${providerServer.port}`
          },
          definitionDigest: "air-quality-v1",
          enabled: true,
          createdAt: now,
          updatedAt: now
        }).execute();
        const provider = await createInferenceProvider(principal.organizationId, {
          kind: "openai-compatible",
          label: "Tool provider",
          apiKey: "provider-secret",
          baseUrl: `http://127.0.0.1:${providerServer.port}`
        });
        await getDb().updateTable("inferenceProviderModels").set({ enabled: true })
          .where("providerId", "=", provider.id).execute();
        const created = await createAgentRun(principal, sessionId, {
          ...runRequest("tool-execute", "Why is the air bad in Sonoma?"),
          modelSelection: `${provider.id}:tool-model`
        });

        const execution = executeAgentRun(created.run.id);
        const approval = await waitForValue(async () => getDb()
          .selectFrom("toolApprovals")
          .select(["id", "status"])
          .where("runId", "=", created.run.id)
          .executeTakeFirst());
        expect(approval.status).toBe("pending");
        const waitingRun = await waitForValue(async () => {
          const row = await getDb().selectFrom("agentRuns").select("status")
            .where("id", "=", created.run.id).executeTakeFirst();
          return row?.status === "waiting_for_approval" ? row : undefined;
        });
        expect(waitingRun.status).toBe("waiting_for_approval");
        await decideToolApproval(
          { ...principal, role: "user" },
          approval.id,
          true
        );
        await execution;

        const run = await getDb().selectFrom("agentRuns").selectAll()
          .where("id", "=", created.run.id).executeTakeFirstOrThrow();
        expect(run.status).toBe("completed");
        expect(run.untrustedContentIngested).toBe(true);
        const assistant = await getDb().selectFrom("sessionMessages")
          .select(["content", "metadata"]).where("id", "=", run.assistantMessageId!)
          .executeTakeFirstOrThrow();
        expect(assistant.content).toBe("Air quality checked.");
        expect(assistant.metadata).toMatchObject({
          schema: "lush.message.parts.v1",
          parts: [
            expect.objectContaining({
              type: "tool",
              toolCallId: "call-weather",
              toolTitle: "Air quality",
              connectionLabel: "Built-in",
              connectionSource: "openapi",
              state: "output-available",
              approvalDecision: "approved"
            }),
            { type: "text", length: "Air quality checked.".length }
          ]
        });
        const events = await listAgentRunEvents(principal, run.id);
        expect(events.map((event) => event.type)).toContain("tool-input");
        expect(events.map((event) => event.type)).toContain("tool-approval-required");
        expect(events.find((event) => event.type === "tool-approval-resolved")?.payload)
          .toMatchObject({ decision: "approved", approvalId: approval.id });
        expect(events.map((event) => event.type)).toContain("tool-output");
        expect(events.find((event) => event.type === "tool-output")?.payload)
          .toMatchObject({ output: { location: "Sonoma", aqi: 87 } });
        const toolCall = await getDb().selectFrom("toolCalls")
          .select(["idempotencyKey", "status"])
          .where("runId", "=", run.id)
          .executeTakeFirstOrThrow();
        expect(toolCall).toMatchObject({ status: "succeeded" });
        expect(toolCall.idempotencyKey).toHaveLength(64);
        const toolRequest = requests.find((request) => Array.isArray(request.tools));
        expect(toolRequest?.tools).toEqual([expect.objectContaining({
          function: expect.objectContaining({ name: "builtin__air_quality" })
        })]);
        const followUp = requests.find((request) =>
          Array.isArray(request.messages) &&
          (request.messages as Array<{ role?: unknown }>).some(
            (message) => message.role === "tool"
          )
        );
        expect(followUp).toBeDefined();
        expect(toolInvocations).toBe(1);

        const deniedSession = await createSession(principal, {
          title: "Denied run test",
          agentId: "lush-chat"
        });
        const denied = await createAgentRun(principal, deniedSession.id, {
          ...runRequest("tool-denied", "Check Sonoma again"),
          modelSelection: `${provider.id}:tool-model`
        });
        const deniedExecution = executeAgentRun(denied.run.id);
        const deniedApproval = await waitForValue(async () => getDb()
          .selectFrom("toolApprovals")
          .select("id")
          .where("runId", "=", denied.run.id)
          .where("status", "=", "pending")
          .executeTakeFirst());
        await waitForValue(async () => {
          const row = await getDb().selectFrom("agentRuns").select("status")
            .where("id", "=", denied.run.id).executeTakeFirst();
          return row?.status === "waiting_for_approval" ? row : undefined;
        });
        await decideToolApproval(
          { ...principal, role: "user" },
          deniedApproval.id,
          false
        );
        await deniedExecution;
        expect(toolInvocations).toBe(1);
        const deniedEvents = await listAgentRunEvents(principal, denied.run.id);
        expect(deniedEvents.find(
          (event) => event.type === "tool-approval-resolved"
        )?.payload).toMatchObject({ decision: "denied" });
        expect(deniedEvents.find((event) => event.type === "tool-output")?.payload)
          .toMatchObject({ errorText: "approval_denied" });
      } finally {
        providerServer.stop(true);
      }
    });
  });
}

function sse(events: unknown[]) {
  return new Response([
    ...events.map((event) => `data: ${JSON.stringify(event)}`),
    "data: [DONE]",
    ""
  ].join("\n"), { headers: { "content-type": "text/event-stream" } });
}

function runRequest(idempotencyKey: string, content: string) {
  return {
    idempotencyKey,
    modelSelection: "test:model",
    message: { role: "user" as const, content },
    metadata: {}
  };
}

async function seedSession() {
  const principal = await seedPrincipal();
  const session = await createSession(principal, {
    title: "Run test",
    agentId: "lush-chat"
  });
  return { principal, sessionId: session.id };
}

async function seedPrincipal(): Promise<AgentRunPrincipal> {
  const now = new Date();
  const user = await getDb().insertInto("users").values({
    email: `${crypto.randomUUID()}@example.com`,
    emailVerified: true,
    displayName: "Run Tester",
    avatarUrl: null,
    createdAt: now,
    updatedAt: now
  }).returning("id").executeTakeFirstOrThrow();
  const organization = await getDb().insertInto("organizations").values({
    name: "Run Test Org",
    slug: `run-test-${crypto.randomUUID()}`,
    createdAt: now,
    updatedAt: now
  }).returning("id").executeTakeFirstOrThrow();
  await getDb().insertInto("organizationMemberships").values({
    organizationId: organization.id,
    userId: user.id,
    role: "user",
    createdAt: now,
    updatedAt: now
  }).execute();
  return { userId: user.id, organizationId: organization.id };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitForValue<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for test state");
}
