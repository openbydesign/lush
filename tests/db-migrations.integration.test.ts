import { expect, test } from "bun:test";
import { sql } from "kysely";
import { createIsolatedTestDatabase } from "../packages/db/src/test";
import { sessionIpColumns } from "../packages/db/src/migrations/009_session_ip_columns";
import { agentRuns } from "../packages/db/src/migrations/013_agent_runs";
import { toolCatalogAcknowledgment } from "../packages/db/src/migrations/015_tool_catalog_acknowledgment";
import { toolGatewayRolloutConvergence } from "../packages/db/src/migrations/016_tool_gateway_rollout_convergence";
import { toolCallDefinitionDigest } from "../packages/db/src/migrations/020_tool_call_definition_digest";
import { toolDefinitionTimeout } from "../packages/db/src/migrations/021_tool_definition_timeout";
import { integrationDatabaseUrl } from "./integration-database";

const databaseUrl = integrationDatabaseUrl();

if (!databaseUrl) {
  test.skip("migration idempotency requires a test database URL", () => {});
} else {
  test("session IP columns converge after the interim migration 008 schema", async () => {
    const harness = await createIsolatedTestDatabase(databaseUrl);

    try {
      await sessionIpColumns.up(harness.db);
      const sessions = await harness.db
        .selectFrom("sessions")
        .select([
          "ipValue",
          "ipMode",
          "lastSeenIpValue",
          "lastSeenIpMode"
        ])
        .execute();

      expect(sessions).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });

  test("agent run constraints converge when migration 013 is replayed", async () => {
    const harness = await createIsolatedTestDatabase(databaseUrl);

    try {
      await sql`
        alter table tool_calls drop constraint if exists tool_calls_run_id_fkey;
        alter table tool_calls drop column run_id;
        alter table tool_approvals drop constraint if exists tool_approvals_run_id_fkey;
        alter table tool_approvals drop column run_id
      `.execute(harness.db);
      await agentRuns.up(harness.db);
      await agentRuns.up(harness.db);
      const columns = await sql<{ tableName: string }>`
        select table_name
        from information_schema.columns
        where table_schema = current_schema()
          and column_name = 'run_id'
          and table_name in ('tool_calls', 'tool_approvals')
        order by table_name
      `.execute(harness.db);
      expect(columns.rows.map((row) => row.tableName)).toEqual([
        "tool_approvals",
        "tool_calls"
      ]);
      const constraints = await sql<{ conname: string }>`
        select conname
        from pg_constraint
        where conname in ('tool_calls_run_id_fkey', 'tool_approvals_run_id_fkey')
          and connamespace = current_schema()::regnamespace
        order by conname
      `.execute(harness.db);
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "tool_approvals_run_id_fkey",
        "tool_calls_run_id_fkey"
      ]);
    } finally {
      await harness.destroy();
    }
  });

  test("tool health constraint repair ignores a same-named constraint in another schema", async () => {
    const harness = await createIsolatedTestDatabase(databaseUrl);

    try {
      await sql`
        alter table tool_connections
          drop constraint tool_connections_health_status_check;
        create temporary table decoy_tool_connections (
          health_status text constraint tool_connections_health_status_check
            check (health_status <> '')
        )
      `.execute(harness.db);

      await toolCatalogAcknowledgment.up(harness.db);

      const constraints = await sql<{ conname: string }>`
        select constraint_record.conname
        from pg_constraint constraint_record
        join pg_class relation on relation.oid = constraint_record.conrelid
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        where constraint_record.conname = 'tool_connections_health_status_check'
          and namespace.nspname = current_schema()
      `.execute(harness.db);
      expect(constraints.rows).toEqual([
        { conname: "tool_connections_health_status_check" }
      ]);
    } finally {
      await harness.destroy();
    }
  });

  test("tool gateway rollout convergence repairs an already-recorded old schema", async () => {
    const harness = await createIsolatedTestDatabase(databaseUrl);

    try {
      await sql`
        alter table organizations drop column tool_gateway_enabled
      `.execute(harness.db);

      await toolGatewayRolloutConvergence.up(harness.db);

      const columns = await sql<{
        isNullable: string;
        columnDefault: string | null;
      }>`
        select is_nullable, column_default
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'organizations'
          and column_name = 'tool_gateway_enabled'
      `.execute(harness.db);
      expect(columns.rows).toHaveLength(1);
      expect(columns.rows[0]?.isNullable).toBe("NO");
      expect(columns.rows[0]?.columnDefault).toBe("false");
    } finally {
      await harness.destroy();
    }
  });

  test("tool-call digest convergence repairs an already-recorded old schema", async () => {
    const harness = await createIsolatedTestDatabase(databaseUrl);

    try {
      await sql`
        alter table tool_calls drop column definition_digest
      `.execute(harness.db);

      await toolCallDefinitionDigest.up(harness.db);
      await toolCallDefinitionDigest.up(harness.db);

      const columns = await sql<{ isNullable: string }>`
        select is_nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'tool_calls'
          and column_name = 'definition_digest'
      `.execute(harness.db);
      expect(columns.rows).toEqual([{ isNullable: "NO" }]);
    } finally {
      await harness.destroy();
    }
  });

  test("tool definition timeout migration is replayable", async () => {
    const harness = await createIsolatedTestDatabase(databaseUrl);

    try {
      await sql`
        alter table tool_definitions drop column timeout_ms
      `.execute(harness.db);

      await toolDefinitionTimeout.up(harness.db);
      await toolDefinitionTimeout.up(harness.db);

      const columns = await sql<{ isNullable: string }>`
        select is_nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'tool_definitions'
          and column_name = 'timeout_ms'
      `.execute(harness.db);
      expect(columns.rows).toEqual([{ isNullable: "YES" }]);
    } finally {
      await harness.destroy();
    }
  });
}
