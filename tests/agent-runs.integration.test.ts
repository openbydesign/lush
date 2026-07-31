import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { closeDb, createDb, getDb } from "../packages/db/src/client";
import { migrateToLatest } from "../packages/db/src/migrate";
import { createInferenceProvider } from "../services/inference/src/runtime";
import { executeAgentRun } from "../services/agent/src/run-executor";
import {
  cancelAgentRun,
  createAgentRun,
  listAgentRunEvents,
  parseRunConfiguration,
  type AgentRunPrincipal
} from "../services/agent/src/runs";
import { createSession } from "../services/sessions/src/runtime";
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

    test("rejects idempotency reuse with a different request", async () => {
      const { principal, sessionId } = await seedSession();
      await createAgentRun(principal, sessionId, runRequest("same-key", "first"));
      await expect(createAgentRun(
        principal,
        sessionId,
        runRequest("same-key", "different")
      )).rejects.toMatchObject({ code: "idempotency_mismatch", status: 409 });
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
  });
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
