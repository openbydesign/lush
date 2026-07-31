import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { createDb, closeDb, getDb } from "../packages/db/src/client";
import { migrateToLatest } from "../packages/db/src/migrate";
import { integrationDatabaseUrl } from "./integration-database";
import {
  acknowledgeConnectionCatalog,
  createToolConnection,
  deleteToolConnection,
  discoverConnectionCatalog,
  getToolGatewaySettings,
  isToolGatewayEnabled,
  listToolConnections,
  listToolDefinitions,
  updateToolConnection,
  updateToolDefinition,
  updateToolGatewaySettings,
  requireVisibleConnection,
  type ToolsPrincipal
} from "../services/tools/src/runtime";
import {
  invokeTool as invokeToolGateway,
  decideToolApproval,
  decideApproval,
  type InvokeToolRequest
} from "../services/tools/src/gateway";
import { canonicalJson, sha256Hex } from "../services/tools/src/digest";
import { validateInput } from "../services/tools/src/validate";
import { createAgentRun } from "../services/agent/src/runs";
import { createSession } from "../services/sessions/src/runtime";
import {
  parseMcpConfig,
  parseOpenApiConfig
} from "../services/tools/src/connector-factory";

async function invokeTool(
  principal: ToolsPrincipal,
  request: Omit<InvokeToolRequest, "expectedDefinitionDigest"> & {
    expectedDefinitionDigest?: string;
  }
) {
  let definitionDigest = request.expectedDefinitionDigest;
  if (!definitionDigest) {
    const definition = await getDb()
      .selectFrom("toolDefinitions")
      .select("definitionDigest")
      .where("connectionId", "=", request.connectionId)
      .where((eb) =>
        eb.or([
          eb("externalName", "=", request.toolName),
          eb("qualifiedName", "=", request.toolName)
        ])
      )
      .executeTakeFirst();
    definitionDigest = definition?.definitionDigest ?? "missing";
  }
  return invokeToolGateway(principal, {
    ...request,
    expectedDefinitionDigest: definitionDigest
  });
}

const databaseUrl = integrationDatabaseUrl();

// decideApproval is pure and always testable.
describe("decideApproval policy", () => {
  const ro = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
  const rw = { readOnly: false, destructive: true, idempotent: false, openWorld: true };

  test("read-only tools are allowed by default", () => {
    expect(decideApproval(ro, {})).toBe("allow");
  });
  test("destructive tools require approval by default", () => {
    expect(decideApproval(rw, {})).toBe("approve");
  });
  test("open-world tools require approval even when a source claims read-only", () => {
    expect(
      decideApproval(
        { readOnly: true, destructive: false, idempotent: true, openWorld: true },
        {}
      )
    ).toBe("approve");
  });
  test("policy 'never' overrides to allow; 'every_call' overrides to approve", () => {
    expect(decideApproval(rw, { approval: "never" })).toBe("allow");
    expect(decideApproval(ro, { approval: "every_call" })).toBe("approve");
  });
  test("policy deny always denies", () => {
    expect(decideApproval(ro, { deny: true })).toBe("deny");
  });
});

test("object enum validation is independent of key insertion order", () => {
  expect(
    validateInput({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 })
  ).toEqual({ ok: true });
});

test("remote connector credential headers reject reserved and invalid names", () => {
  for (const parse of [parseMcpConfig, parseOpenApiConfig]) {
    expect(() => parse({ url: "https://tools.example", authHeader: "Host" }))
      .toThrow("reserved");
    expect(() => parse({ url: "https://tools.example", authHeader: "x-api-key\r\nx" }))
      .toThrow("invalid");
    expect(parse({ url: "https://tools.example", authHeader: "X-API-Key" }))
      .toMatchObject({ authHeader: "x-api-key" });
  }
});

if (!databaseUrl) {
  test.skip("tool gateway integration requires a test database URL", () => {});
} else {
  describe("tool gateway", () => {
    let schemaName: string;
    let adminDb: ReturnType<typeof createDb>;
    let previousDatabaseUrl: string | undefined;
    let previousSecret: string | undefined;
    let previousToolKey: string | undefined;
    let previousEgress: string | undefined;

    beforeAll(async () => {
      previousDatabaseUrl = process.env.DATABASE_URL;
      previousSecret = process.env.LUSH_SECRET_KEY;
      previousToolKey = process.env.LUSH_TOOL_CREDENTIAL_KEY;
      previousEgress = process.env.LUSH_TOOLS_ALLOW_PRIVATE_EGRESS;
      process.env.LUSH_SECRET_KEY = "test-secret-key";
      process.env.LUSH_TOOL_CREDENTIAL_KEY = "test-tool-credential-key";
      process.env.LUSH_TOOLS_ALLOW_PRIVATE_EGRESS = "true";

      schemaName = `test_${crypto.randomUUID().replace(/-/g, "")}`;
      adminDb = createDb({ databaseUrl });
      await sql`create schema ${sql.ref(schemaName)}`.execute(adminDb);

      const schemaUrl = new URL(databaseUrl);
      schemaUrl.searchParams.set("options", `-c search_path=${schemaName}`);
      // Bind the shared getDb() singleton (used by runtime + gateway) to the
      // isolated schema so setup and system-under-test share one search path.
      process.env.DATABASE_URL = schemaUrl.toString();
      await closeDb();
      await migrateToLatest(getDb());
    });

    afterAll(async () => {
      await closeDb();
      await sql`drop schema if exists ${sql.ref(schemaName)} cascade`.execute(adminDb);
      await adminDb.destroy();
      restoreEnv("DATABASE_URL", previousDatabaseUrl);
      restoreEnv("LUSH_SECRET_KEY", previousSecret);
      restoreEnv("LUSH_TOOL_CREDENTIAL_KEY", previousToolKey);
      restoreEnv("LUSH_TOOLS_ALLOW_PRIVATE_EGRESS", previousEgress);
    });

    afterEach(async () => {
      // Keep each test independent without dropping the schema.
      const db = getDb();
      await db.deleteFrom("toolApprovals").execute();
      await db.deleteFrom("toolCalls").execute();
      await db.deleteFrom("toolDefinitions").execute();
      await db.deleteFrom("toolCredentialBindings").execute();
      await db.deleteFrom("toolConnections").execute();
      openApiVersion = 1;
    });

    // ---- MCP mock server ---------------------------------------------------
    let server: ReturnType<typeof Bun.serve>;
    let endpoint: string;
    beforeAll(() => {
      server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: mcpMock });
      endpoint = `http://127.0.0.1:${server.port}/mcp`;
    });
    afterAll(() => server.stop(true));

    async function seedPrincipal(role: "admin" | "user" = "admin"): Promise<ToolsPrincipal> {
      const db = getDb();
      const now = new Date();
      const user = await db
        .insertInto("users")
        .values({
          email: `${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          displayName: "Tool Tester",
          avatarUrl: null,
          createdAt: now,
          updatedAt: now
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const org = await db
        .insertInto("organizations")
        .values({
          name: "Org",
          slug: `org-${crypto.randomUUID()}`,
          createdAt: now,
          updatedAt: now
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("organizationMemberships")
        .values({
          organizationId: org.id,
          userId: user.id,
          role,
          createdAt: now,
          updatedAt: now
        })
        .execute();
      return { userId: user.id, organizationId: org.id, role };
    }

    async function seedMember(
      organizationId: string,
      role: "admin" | "user"
    ): Promise<ToolsPrincipal> {
      const db = getDb();
      const now = new Date();
      const user = await db
        .insertInto("users")
        .values({
          email: `${crypto.randomUUID()}@example.com`,
          emailVerified: true,
          displayName: "Member",
          avatarUrl: null,
          createdAt: now,
          updatedAt: now
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("organizationMemberships")
        .values({ organizationId, userId: user.id, role, createdAt: now, updatedAt: now })
        .execute();
      return { userId: user.id, organizationId, role };
    }

    async function builtInConnection(principal: ToolsPrincipal) {
      const connection = (await listToolConnections(principal)).find(
        (candidate) => candidate.systemManaged && candidate.source === "native"
      );
      if (!connection) throw new Error("Built-in tool connection was not provisioned");
      return connection;
    }

    async function allowedMcpConnection(principal: ToolsPrincipal) {
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "Allowed mock MCP",
        endpoint: { url: endpoint }
      });
      const definitions = await discoverConnectionCatalog(
        principal,
        connection.id,
        new AbortController().signal
      );
      await updateToolConnection(principal, {
        connectionId: connection.id,
        policy: { approval: "never" }
      });
      return { connection, definitions };
    }

    test("the built-in catalog is provisioned without placeholder tools", async () => {
      const principal = await seedPrincipal("admin");
      const provisioned = await builtInConnection(principal);
      expect(provisioned).toMatchObject({
        scope: "organization",
        source: "native",
        systemManaged: true,
        enabled: true,
        label: "Built-in tools"
      });
      expect(await listToolDefinitions(principal, provisioned.id)).toEqual([]);
      await expect(
        createToolConnection(principal, {
          scope: "organization",
          source: "native",
          label: "Duplicate built-in"
        })
      ).rejects.toMatchObject({ code: "invalid_connection" });
      await expect(
        discoverConnectionCatalog(principal, provisioned.id, new AbortController().signal)
      ).rejects.toMatchObject({ code: "system_connection_managed" });
      await expect(deleteToolConnection(principal, provisioned.id)).rejects.toMatchObject({
        code: "system_connection_managed"
      });
      await expect(
        updateToolConnection(principal, { connectionId: provisioned.id, enabled: false })
      ).rejects.toMatchObject({ code: "system_connection_managed" });
    });

    test("tool gateway rollout is disabled per organization by default", async () => {
      const principal = await seedPrincipal("admin");
      expect(await isToolGatewayEnabled(principal.organizationId)).toBe(false);
      await getDb()
        .updateTable("organizations")
        .set({ toolGatewayEnabled: true })
        .where("id", "=", principal.organizationId)
        .execute();
      expect(await isToolGatewayEnabled(principal.organizationId)).toBe(true);
    });

    test("tool gateway settings are readable by members and writable only by admins", async () => {
      const admin = await seedPrincipal("admin");
      const member = await seedMember(admin.organizationId, "user");
      expect(await getToolGatewaySettings(member)).toEqual({
        enabled: false,
        canManageOrganization: false
      });
      await expect(updateToolGatewaySettings(member, true)).rejects.toMatchObject({
        code: "forbidden"
      });
      expect(await updateToolGatewaySettings(admin, true)).toEqual({
        enabled: true,
        canManageOrganization: true
      });
    });

    test("input validation rejects unexpected properties before invocation", async () => {
      const principal = await seedPrincipal("admin");
      const { connection } = await allowedMcpConnection(principal);

      await expect(
        invokeTool(principal, {
          connectionId: connection.id,
          toolName: "echo",
          input: { unexpected: true }
        })
      ).rejects.toMatchObject({ code: "input_invalid" });
    });

    test("tool JSON Schemas preserve provider-defined snake_case property names", async () => {
      const principal = await seedPrincipal("admin");
      const { definitions } = await allowedMcpConnection(principal);
      const definition = definitions.find((candidate) => candidate.externalName === "echo")!;
      const inputSchema = {
        type: "object",
        properties: {
          search_queries: { type: "array", items: { type: "string" } }
        },
        required: ["search_queries"],
        additionalProperties: false
      };

      await getDb()
        .updateTable("toolDefinitions")
        .set({ inputSchema })
        .where("id", "=", definition.id)
        .execute();

      const loaded = await getDb()
        .selectFrom("toolDefinitions")
        .select("inputSchema")
        .where("id", "=", definition.id)
        .executeTakeFirstOrThrow();
      expect(loaded.inputSchema).toEqual(inputSchema);
      expect(validateInput(loaded.inputSchema, { search_queries: "not-an-array" }))
        .toEqual({
          ok: false,
          errors: ["$.search_queries: expected array"]
        });
    });

    test("malformed resource identifiers fail as client errors", async () => {
      const principal = await seedPrincipal("admin");
      await expect(requireVisibleConnection(principal, "not-a-uuid")).rejects.toMatchObject({
        code: "connection_not_found",
        status: 404
      });
      await expect(
        decideToolApproval(principal, "not-a-uuid", true)
      ).rejects.toMatchObject({ code: "invalid_approval", status: 400 });
    });

    test("a user-private connection is invisible to other members and admins", async () => {
      const owner = await seedPrincipal("user");
      const otherUser = await seedMember(owner.organizationId, "user");
      const admin = await seedMember(owner.organizationId, "admin");

      const priv = await createToolConnection(owner, {
        scope: "user",
        source: "mcp",
        label: "My private tools",
        endpoint: { url: endpoint }
      });

      // Owner sees it.
      expect((await listToolConnections(owner)).map((c) => c.id)).toContain(priv.id);
      // Another member does not.
      expect((await listToolConnections(otherUser)).map((c) => c.id)).not.toContain(priv.id);
      // An admin does not gain access merely by being an admin.
      expect((await listToolConnections(admin)).map((c) => c.id)).not.toContain(priv.id);

      await expect(requireVisibleConnection(otherUser, priv.id)).rejects.toMatchObject({
        code: "connection_not_found"
      });
      await expect(
        invokeTool(otherUser, {
          connectionId: priv.id,
          toolName: "echo",
          input: {}
        })
      ).rejects.toMatchObject({ code: "connection_not_found" });
    });

    test("non-admins cannot create or manage organization connections", async () => {
      const admin = await seedPrincipal("admin");
      const member = await seedMember(admin.organizationId, "user");

      await expect(
        createToolConnection(member, {
          scope: "organization",
          source: "mcp",
          label: "Shared",
          endpoint: { url: endpoint }
        })
      ).rejects.toMatchObject({ code: "forbidden" });

      await expect(
        createToolConnection(member, {
          source: "mcp",
          label: "Missing scope",
          endpoint: { url: endpoint }
        } as never)
      ).rejects.toMatchObject({ code: "invalid_connection" });

      const shared = await createToolConnection(admin, {
        scope: "organization",
        source: "mcp",
        label: "Shared",
        endpoint: { url: endpoint }
      });
      await expect(
        updateToolConnection(member, { connectionId: shared.id, enabled: false })
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        discoverConnectionCatalog(member, shared.id, new AbortController().signal)
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        acknowledgeConnectionCatalog(member, shared.id)
      ).rejects.toMatchObject({ code: "forbidden" });

      const [sharedDefinition] = await discoverConnectionCatalog(
        admin,
        shared.id,
        new AbortController().signal
      );
      await expect(
        updateToolDefinition(member, {
          definitionId: sharedDefinition!.id,
          enabled: true
        })
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    test("rejects secrets without a credential mode and plaintext endpoint headers", async () => {
      const principal = await seedPrincipal("admin");
      await expect(
        createToolConnection(principal, {
          scope: "organization",
          source: "mcp",
          label: "Unused secret",
          endpoint: { url: endpoint },
          secret: "must-not-store"
        })
      ).rejects.toMatchObject({ code: "invalid_connection" });
      await expect(
        createToolConnection(principal, {
          scope: "organization",
          source: "mcp",
          label: "Plaintext header",
          endpoint: { url: endpoint, headers: { authorization: "Bearer plaintext" } }
        })
      ).rejects.toMatchObject({ code: "invalid_endpoint" });

      const noCredential = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "No credentials",
        endpoint: { url: endpoint }
      });
      await expect(
        updateToolConnection(principal, {
          connectionId: noCredential.id,
          secret: "must-not-store"
        })
      ).rejects.toMatchObject({ code: "invalid_connection" });
    });

    test("disabled tools deny invocation independently of their connection", async () => {
      const principal = await seedPrincipal("admin");
      const { connection, definitions } = await allowedMcpConnection(principal);
      const definition = definitions.find((candidate) => candidate.externalName === "echo")!;
      await updateToolDefinition(principal, {
        definitionId: definition.id,
        enabled: false
      });

      const outcome = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "echo",
        input: {}
      });
      expect(outcome).toMatchObject({ status: "denied", reason: "tool_disabled" });
    });

    test("definition timeout overrides are validated and enforced by the gateway", async () => {
      const principal = await seedPrincipal("admin");
      const { connection, definitions } = await allowedMcpConnection(principal);
      const definition = definitions.find((candidate) => candidate.externalName === "echo")!;

      const updated = await updateToolDefinition(principal, {
        definitionId: definition.id,
        timeoutMs: 1_000
      });
      expect(updated.timeoutMs).toBe(1_000);
      await expect(updateToolDefinition(principal, {
        definitionId: definition.id,
        timeoutMs: 999
      })).rejects.toMatchObject({ code: "invalid_definition_timeout" });

      const startedAt = Date.now();
      const outcome = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "echo",
        input: { message: "slow" }
      });
      expect(outcome.status).toBe("failed");
      expect(Date.now() - startedAt).toBeLessThan(2_500);

      const restored = await updateToolDefinition(principal, {
        definitionId: definition.id,
        timeoutMs: null
      });
      expect(restored.timeoutMs).toBeNull();
    });

    test("MCP connection: discover, invoke over SSE, and enforce the approval binding", async () => {
      const principal = await seedPrincipal("admin");
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "Mock MCP",
        endpoint: { url: endpoint }
      });

      const definitions = await discoverConnectionCatalog(
        principal,
        connection.id,
        new AbortController().signal
      );
      expect(definitions.map((d) => d.externalName).sort()).toEqual(["add", "echo"]);
      expect(definitions.find((definition) => definition.externalName === "echo")?.annotations)
        .toEqual({
          readOnly: false,
          destructive: true,
          idempotent: false,
          openWorld: true
        });

      // The remote server's read-only hint is untrusted, so echo remains in the
      // restrictive approval class until Lush-owned review metadata exists.
      const echoApproval = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "echo",
        input: { hello: "world" }
      });
      expect(echoApproval.status).toBe("approval_required");
      if (echoApproval.status !== "approval_required") return;
      await decideToolApproval(principal, echoApproval.approval.approvalId, true);
      const echo = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "echo",
        input: { hello: "world" }
      });
      expect(echo.status).toBe("succeeded");

      // add has no annotation hints -> restrictive -> approval required.
      const first = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "add",
        input: { a: 2, b: 3 }
      });
      expect(first.status).toBe("approval_required");
      if (first.status !== "approval_required") return;

      await decideToolApproval(principal, first.approval.approvalId, true);

      // Same input now proceeds against the approved binding, REUSING the call
      // row created at approval time (no orphaned "proposed" call left behind).
      const second = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "add",
        input: { a: 2, b: 3 }
      });
      expect(second.status).toBe("succeeded");
      if (second.status === "succeeded") {
        expect(second.result.structured).toEqual({ sum: 5 });
        expect(second.toolCallId).toBe(first.toolCallId);
      }
      const proposed = await getDb()
        .selectFrom("toolCalls")
        .selectAll()
        .where("status", "=", "proposed")
        .execute();
      expect(proposed).toHaveLength(0);

      // The approval is single-use: re-invoking the same input requires a fresh
      // approval rather than silently re-running.
      const replay = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "add",
        input: { a: 2, b: 3 }
      });
      expect(replay.status).toBe("approval_required");

      // Editing arguments also requires approval (different input digest).
      const third = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "add",
        input: { a: 9, b: 9 }
      });
      expect(third.status).toBe("approval_required");
    });

    test("OpenAPI discovery records health, catalog changes, policy, and invokes through the gateway", async () => {
      const principal = await seedPrincipal("admin");
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "openapi",
        label: "Mock OpenAPI",
        endpoint: { url: endpoint.replace("/mcp", "/openapi.json") }
      });
      expect(connection.health.status).toBe("unknown");

      const definitions = await discoverConnectionCatalog(
        principal,
        connection.id,
        new AbortController().signal
      );
      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatchObject({
        externalName: "getPet",
        policy: {
          decision: "approve",
          reasons: ["tool_destructive", "tool_open_world"]
        }
      });
      expect(JSON.stringify(definitions[0]?.outputSchema)).not.toContain("$ref");
      expect(definitions[0]?.outputSchema).toMatchObject({
        properties: { owner: { properties: { name: { type: "string" } } } }
      });
      expect((await listToolConnections(principal))[0]).toMatchObject({
        catalogChanged: false,
        health: { status: "healthy", errorCode: null }
      });

      const first = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "getPet",
        input: { path: { petId: "42" }, query: { detail: true } }
      });
      expect(first.status).toBe("approval_required");
      if (first.status !== "approval_required") return;
      await decideToolApproval(principal, first.approval.approvalId, true);
      const result = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "getPet",
        input: { path: { petId: "42" }, query: { detail: true } }
      });
      expect(result).toMatchObject({
        status: "succeeded",
        result: { structured: { id: "42", detail: true } }
      });

      const traversalPending = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "getPet",
        input: { path: { petId: ".." } }
      });
      expect(traversalPending.status).toBe("approval_required");
      if (traversalPending.status !== "approval_required") return;
      await decideToolApproval(
        principal,
        traversalPending.approval.approvalId,
        true
      );
      const traversal = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "getPet",
        input: { path: { petId: ".." } }
      });
      expect(traversal).toMatchObject({ status: "failed" });
      expect(JSON.stringify(traversal)).toContain("openapi_path_parameter_unsafe");

      openApiVersion = 2;
      await discoverConnectionCatalog(principal, connection.id, new AbortController().signal);
      expect((await listToolConnections(principal))[0]?.catalogChanged).toBe(true);
      await discoverConnectionCatalog(principal, connection.id, new AbortController().signal);
      expect((await listToolConnections(principal))[0]?.catalogChanged).toBe(true);
      await acknowledgeConnectionCatalog(principal, connection.id);
      expect((await listToolConnections(principal))[0]?.catalogChanged).toBe(false);
      await discoverConnectionCatalog(principal, connection.id, new AbortController().signal);
      expect((await listToolConnections(principal))[0]?.catalogChanged).toBe(false);
    });

    test("OpenAPI discovery rejects cross-origin servers and cyclic schemas", async () => {
      const principal = await seedPrincipal("admin");
      for (const [variant, code] of [
        ["cross-origin", "openapi_cross_origin_server"],
        ["cycle", "openapi_schema_cycle"]
      ] as const) {
        const connection = await createToolConnection(principal, {
          scope: "organization",
          source: "openapi",
          label: `Mock OpenAPI ${variant}`,
          endpoint: {
            url: `${endpoint.replace("/mcp", "/openapi.json")}?variant=${variant}`
          }
        });
        await expect(
          discoverConnectionCatalog(
            principal,
            connection.id,
            new AbortController().signal
          )
        ).rejects.toMatchObject({ code });
      }
    });

    test("an approval granted for one run does not authorize another run", async () => {
      const principal = await seedPrincipal("admin");
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "Mock MCP",
        endpoint: { url: endpoint }
      });
      await discoverConnectionCatalog(principal, connection.id, new AbortController().signal);

      const runA = await seedToolRun(principal);
      const runB = await seedToolRun(principal);
      const input = { a: 2, b: 3 };

      const first = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "add",
        input,
        runId: runA
      });
      expect(first.status).toBe("approval_required");
      if (first.status !== "approval_required") return;
      await decideToolApproval(principal, first.approval.approvalId, true);

      // A different run with identical input is NOT covered by run A's approval.
      const otherRun = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "add",
        input,
        runId: runB
      });
      expect(otherRun.status).toBe("approval_required");

      // The originating run proceeds against its own approval.
      const sameRun = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "add",
        input,
        runId: runA
      });
      expect(sameRun.status).toBe("succeeded");
    });

    async function seedToolRun(principal: ToolsPrincipal) {
      const session = await createSession(principal, {
        title: "Tool approval run",
        agentId: "lush-chat"
      });
      const { run } = await createAgentRun(principal, session.id, {
        idempotencyKey: crypto.randomUUID(),
        modelSelection: "test:model",
        message: { role: "user", content: "Invoke a tool" },
        metadata: {}
      });
      return run.id;
    }

    test("only the initiating principal may decide an approval", async () => {
      const principal = await seedPrincipal("admin");
      const other = await seedMember(principal.organizationId, "user");
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "Mock MCP",
        endpoint: { url: endpoint }
      });
      await discoverConnectionCatalog(principal, connection.id, new AbortController().signal);
      const pending = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "add",
        input: { a: 1, b: 2 }
      });
      expect(pending.status).toBe("approval_required");
      if (pending.status !== "approval_required") return;

      await expect(
        decideToolApproval(other, pending.approval.approvalId, true)
      ).rejects.toMatchObject({ code: "approval_not_found" });
    });

    test("an approved call is consumed at most once under concurrent retry", async () => {
      const principal = await seedPrincipal("admin");
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "Mock MCP",
        endpoint: { url: endpoint }
      });
      await discoverConnectionCatalog(principal, connection.id, new AbortController().signal);
      const request = {
        connectionId: connection.id,
        toolName: "add",
        input: { a: 4, b: 5 }
      };
      const pending = await invokeTool(principal, request);
      expect(pending.status).toBe("approval_required");
      if (pending.status !== "approval_required") return;
      await decideToolApproval(principal, pending.approval.approvalId, true);

      let invocations = 0;
      toolCallSink = () => {
        invocations += 1;
      };
      try {
        const results = await Promise.allSettled([
          invokeTool(principal, request),
          invokeTool(principal, request)
        ]);
        expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      } finally {
        toolCallSink = undefined;
      }
      expect(invocations).toBe(1);
    });

    test("an idempotency key reserves and resumes one approval-bound call", async () => {
      const principal = await seedPrincipal("admin");
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "Mock MCP",
        endpoint: { url: endpoint }
      });
      await discoverConnectionCatalog(principal, connection.id, new AbortController().signal);
      const key = crypto.randomUUID();
      const request = {
        connectionId: connection.id,
        toolName: "add",
        input: { a: 6, b: 7 },
        idempotencyKey: key
      };

      const first = await invokeTool(principal, request);
      const pendingReplay = await invokeTool(principal, request);
      expect(first.status).toBe("approval_required");
      expect(pendingReplay).toEqual(first);
      if (first.status !== "approval_required") return;
      await decideToolApproval(principal, first.approval.approvalId, true);

      const executed = await invokeTool(principal, request);
      const completedReplay = await invokeTool(principal, request);
      expect(executed.status).toBe("succeeded");
      expect(completedReplay.status).toBe("succeeded");
      if (executed.status === "succeeded" && completedReplay.status === "succeeded") {
        expect(completedReplay.toolCallId).toBe(executed.toolCallId);
      }
      expect(
        await getDb()
          .selectFrom("toolCalls")
          .selectAll()
          .where("idempotencyKey", "=", key)
          .execute()
      ).toHaveLength(1);
    });

    test("expiring an approval closes its pending tool call", async () => {
      const principal = await seedPrincipal("admin");
      const { connection, definitions } = await allowedMcpConnection(principal);
      const [definition] = definitions;
      const db = getDb();
      const past = new Date(Date.now() - 60_000);

      const call = await db
        .insertInto("toolCalls")
        .values({
          organizationId: principal.organizationId,
          connectionId: connection.id,
          toolDefinitionId: definition!.id,
          initiatedByUserId: principal.userId,
          status: "waiting_for_approval",
          input: {},
          inputDigest: "d",
          definitionDigest: definition!.definitionDigest,
          isError: false,
          createdAt: new Date()
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const approval = await db
        .insertInto("toolApprovals")
        .values({
          organizationId: principal.organizationId,
          toolCallId: call.id,
          connectionId: connection.id,
          toolDefinitionId: definition!.id,
          initiatedByUserId: principal.userId,
          inputDigest: "d",
          definitionDigest: definition!.definitionDigest,
          scope: "once",
          status: "pending",
          expiresAt: past,
          createdAt: past
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await expect(
        decideToolApproval(principal, approval.id, true)
      ).rejects.toMatchObject({ code: "approval_expired" });

      const closed = await db
        .selectFrom("toolCalls")
        .select(["status", "completedAt"])
        .where("id", "=", call.id)
        .executeTakeFirstOrThrow();
      expect(closed.status).toBe("cancelled");
      expect(closed.completedAt).not.toBeNull();
    });

    test("expectedDefinitionDigest mismatch fails closed", async () => {
      const principal = await seedPrincipal("admin");
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "Mock MCP",
        endpoint: { url: endpoint }
      });
      const definitions = await discoverConnectionCatalog(
        principal,
        connection.id,
        new AbortController().signal
      );
      const echoDef = definitions.find((d) => d.externalName === "echo")!;

      const stale = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "echo",
        input: {},
        expectedDefinitionDigest: "sha256:not-the-real-digest"
      });
      expect(stale).toMatchObject({ status: "denied", reason: "definition_changed" });

      const current = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "echo",
        input: {},
        expectedDefinitionDigest: echoDef.definitionDigest
      });
      expect(current.status).toBe("approval_required");

      await expect(
        invokeToolGateway(
          principal,
          {
            connectionId: connection.id,
            toolName: "echo",
            input: {}
          } as unknown as InvokeToolRequest
        )
      ).rejects.toMatchObject({ code: "definition_digest_required" });
    });

    test("idempotency replays a failed call and rejects an in-flight one", async () => {
      const principal = await seedPrincipal("admin");
      const { connection, definitions } = await allowedMcpConnection(principal);
      const definition = definitions.find((candidate) => candidate.externalName === "echo")!;
      const now = new Date();
      const emptyInputDigest = await sha256Hex(canonicalJson({}));

      // A prior FAILED call with a key is replayed as failed, not re-executed
      // (which would hit the unique index and previously threw a raw DB error).
      const failedKey = crypto.randomUUID();
      const failed = await getDb()
        .insertInto("toolCalls")
        .values({
          organizationId: principal.organizationId,
          connectionId: connection.id,
          toolDefinitionId: definition!.id,
          initiatedByUserId: principal.userId,
          status: "failed",
          input: {},
          inputDigest: emptyInputDigest,
          definitionDigest: definition!.definitionDigest,
          isError: true,
          outputPreview: { isError: true, content: [{ type: "text", text: "boom" }] },
          idempotencyKey: failedKey,
          createdAt: now,
          completedAt: now
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const replayFailed = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "echo",
        input: {},
        idempotencyKey: failedKey
      });
      expect(replayFailed).toMatchObject({ status: "failed", toolCallId: failed.id });

      // A prior RUNNING call with a key is an ambiguous in-flight conflict.
      const runningKey = crypto.randomUUID();
      await getDb()
        .insertInto("toolCalls")
        .values({
          organizationId: principal.organizationId,
          connectionId: connection.id,
          toolDefinitionId: definition!.id,
          initiatedByUserId: principal.userId,
          status: "running",
          input: {},
          inputDigest: emptyInputDigest,
          definitionDigest: definition!.definitionDigest,
          isError: false,
          idempotencyKey: runningKey,
          createdAt: now
        })
        .execute();

      await expect(
        invokeTool(principal, {
          connectionId: connection.id,
          toolName: "echo",
          input: {},
          idempotencyKey: runningKey
        })
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    });

    test("idempotency key returns the prior successful call", async () => {
      const principal = await seedPrincipal("admin");
      const { connection } = await allowedMcpConnection(principal);

      const key = crypto.randomUUID();
      const one = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "echo",
        input: { message: "hello" },
        idempotencyKey: key
      });
      const two = await invokeTool(principal, {
        connectionId: connection.id,
        toolName: "echo",
        input: { message: "hello" },
        idempotencyKey: key
      });
      expect(one.status).toBe("succeeded");
      expect(two.status).toBe("succeeded");
      if (one.status === "succeeded" && two.status === "succeeded") {
        expect(two.toolCallId).toBe(one.toolCallId);
      }
      const calls = await getDb().selectFrom("toolCalls").selectAll().execute();
      expect(calls).toHaveLength(1);
    });

    test("concurrent use of one idempotency key creates at most one call", async () => {
      const principal = await seedPrincipal("admin");
      const { connection } = await allowedMcpConnection(principal);
      const key = crypto.randomUUID();
      const request = {
        connectionId: connection.id,
        toolName: "echo",
        input: { message: "hello" },
        idempotencyKey: key
      };
      const results = await Promise.allSettled([
        invokeTool(principal, request),
        invokeTool(principal, request)
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      expect(
        await getDb()
          .selectFrom("toolCalls")
          .selectAll()
          .where("idempotencyKey", "=", key)
          .execute()
      ).toHaveLength(1);
    });

    test("idempotency is principal-scoped and rejects operation mismatches", async () => {
      const owner = await seedPrincipal("admin");
      const member = await seedMember(owner.organizationId, "user");
      const { connection } = await allowedMcpConnection(owner);

      const sharedKey = crypto.randomUUID();
      const ownerCall = await invokeTool(owner, {
        connectionId: connection.id,
        toolName: "echo",
        input: { message: "hello" },
        idempotencyKey: sharedKey
      });
      const memberCall = await invokeTool(member, {
        connectionId: connection.id,
        toolName: "echo",
        input: { message: "hello" },
        idempotencyKey: sharedKey
      });
      expect(ownerCall.status).toBe("succeeded");
      expect(memberCall.status).toBe("succeeded");
      if (ownerCall.status === "succeeded" && memberCall.status === "succeeded") {
        expect(memberCall.toolCallId).not.toBe(ownerCall.toolCallId);
      }

      await expect(
        invokeTool(owner, {
          connectionId: connection.id,
          toolName: "echo",
          input: { message: "different" },
          idempotencyKey: sharedKey
        })
      ).rejects.toMatchObject({ code: "idempotency_mismatch" });
    });

    test("an organization credential is stored encrypted and sent to the MCP server", async () => {
      const principal = await seedPrincipal("admin");
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "Authed MCP",
        endpoint: { url: endpoint },
        credentialMode: "organization",
        secret: "bearer-token-xyz"
      });
      expect(connection.hasCredential).toBe(true);

      // The stored envelope must not contain plaintext.
      const binding = await getDb()
        .selectFrom("toolCredentialBindings")
        .selectAll()
        .where("connectionId", "=", connection.id)
        .executeTakeFirstOrThrow();
      expect(binding.encryptedSecret).not.toContain("bearer-token-xyz");
      expect(binding.subjectUserId).toBeNull();

      const seenAuth: string[] = [];
      authHeaderSink = (value) => seenAuth.push(value);
      try {
        await discoverConnectionCatalog(principal, connection.id, new AbortController().signal);
      } finally {
        authHeaderSink = undefined;
      }
      expect(seenAuth).toContain("Bearer bearer-token-xyz");

      // Removing the secret clears the credential flag.
      const updated = await updateToolConnection(principal, {
        connectionId: connection.id,
        secret: null
      });
      expect(updated.hasCredential).toBe(false);
    });

    test("deleting a connection removes its definitions and credentials", async () => {
      const principal = await seedPrincipal("admin");
      const connection = await createToolConnection(principal, {
        scope: "organization",
        source: "mcp",
        label: "Disposable MCP",
        endpoint: { url: endpoint },
        credentialMode: "organization",
        secret: "temporary-secret"
      });
      await discoverConnectionCatalog(principal, connection.id, new AbortController().signal);
      await deleteToolConnection(principal, connection.id);

      expect((await listToolConnections(principal)).map((row) => row.id)).not.toContain(
        connection.id
      );
      expect(
        await getDb()
          .selectFrom("toolDefinitions")
          .selectAll()
          .where("connectionId", "=", connection.id)
          .execute()
      ).toHaveLength(0);
      expect(
        await getDb()
          .selectFrom("toolCredentialBindings")
          .selectAll()
          .where("connectionId", "=", connection.id)
          .execute()
      ).toHaveLength(0);
    });
  });
}

// ---------------------------------------------------------------------------

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

let authHeaderSink: ((value: string) => void) | undefined;
let toolCallSink: (() => void) | undefined;
let openApiVersion = 1;

async function mcpMock(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/openapi.json") {
    const variant = url.searchParams.get("variant");
    return Response.json({
      openapi: "3.1.0",
      info: { title: "Mock", version: String(openApiVersion) },
      servers:
        variant === "cross-origin"
          ? [{ url: url.origin }, { url: "https://other.example" }]
          : [{ url: url.origin }],
      components: {
        schemas: {
          Owner: {
            type: "object",
            properties: { name: { type: "string" } }
          },
          Pet: {
            type: "object",
            properties: {
              id: { type: "string" },
              owner: { $ref: "#/components/schemas/Owner" }
            }
          },
          CycleA: { $ref: "#/components/schemas/CycleB" },
          CycleB: { $ref: "#/components/schemas/CycleA" }
        }
      },
      paths: {
        "/pets/{petId}": {
          get: {
            operationId: "getPet",
            summary: "Get pet",
            parameters: [
              {
                name: "petId",
                in: "path",
                required: true,
                schema: { type: "string" }
              },
              {
                name: "detail",
                in: "query",
                schema: { type: openApiVersion === 1 ? "boolean" : "string" }
              }
            ],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      $ref:
                        variant === "cycle"
                          ? "#/components/schemas/CycleA"
                          : "#/components/schemas/Pet"
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
  }
  if (url.pathname === "/pets/42") {
    return Response.json({
      id: "42",
      detail: url.searchParams.get("detail") === "true"
    });
  }
  if (request.method === "GET") {
    return new Response("not found", { status: 404 });
  }
  const auth = request.headers.get("authorization");
  if (auth && authHeaderSink) {
    authHeaderSink(auth);
  }
  if (request.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  const body = (await request.json()) as {
    id?: unknown;
    method: string;
    params?: Record<string, unknown>;
  };
  const json = (payload: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", ...headers }
    });
  const result = (r: unknown) => ({ jsonrpc: "2.0", id: body.id, result: r });

  switch (body.method) {
    case "initialize":
      return json(
        result({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "mock", version: "1.0.0" }
        }),
        { "mcp-session-id": "sess-1" }
      );
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "tools/list":
      return json(
        result({
          tools: [
            {
              name: "echo",
              description: "echo",
              inputSchema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  hello: { type: "string" }
                },
                additionalProperties: false
              },
              annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
            },
            {
              name: "add",
              description: "add",
              inputSchema: { type: "object" }
            }
          ]
        })
      );
    case "tools/call": {
      toolCallSink?.();
      const name = body.params?.name;
      const args = (body.params?.arguments ?? {}) as {
        a?: number;
        b?: number;
        message?: string;
      };
      if (name === "echo") {
        if (args.message === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 1_200));
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: message\ndata: ${JSON.stringify(
                  result({ content: [{ type: "text", text: "ok" }] })
                )}\n\n`
              )
            );
            controller.close();
          }
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (name === "add") {
        const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
        return json(
          result({ content: [{ type: "text", text: String(sum) }], structuredContent: { sum } })
        );
      }
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
    }
    default:
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
  }
}
