import { sql } from "kysely";
import type { Migration } from "./types";

/** Keep catalog drift visible until a connection manager reviews it. */
export const toolCatalogAcknowledgment: Migration = {
  id: "015_tool_catalog_acknowledgment",
  async up(db) {
    await sql`
      alter table tool_connections
      add column if not exists catalog_acknowledged_version text
    `.execute(db);

    // Migration 014's name-only lookup could be satisfied by a constraint in a
    // different schema. Repair that case append-only without rewriting an
    // already-applied migration.
    await sql`
      do $$
      begin
        if not exists (
          select 1
          from pg_constraint constraint_record
          join pg_class relation
            on relation.oid = constraint_record.conrelid
          join pg_namespace namespace
            on namespace.oid = relation.relnamespace
          where constraint_record.conname = 'tool_connections_health_status_check'
            and namespace.nspname = current_schema()
        ) then
          alter table tool_connections
            add constraint tool_connections_health_status_check
            check (health_status in ('unknown', 'healthy', 'unhealthy'));
        end if;
      end $$
    `.execute(db);
  }
};
