import { sql } from "kysely";
import type { Migration } from "./types";

/** Product-visible connection health and connector invocation metadata. */
export const toolControlPlane: Migration = {
  id: "014_tool_control_plane",
  async up(db) {
    await sql`
      alter table tool_connections
        add column if not exists catalog_changed boolean not null default false,
        add column if not exists health_status text not null default 'unknown',
        add column if not exists health_checked_at timestamptz,
        add column if not exists health_error_code text
    `.execute(db);

    await sql`
      do $$
      begin
        if not exists (
          select 1 from pg_constraint
          where conname = 'tool_connections_health_status_check'
        ) then
          alter table tool_connections
            add constraint tool_connections_health_status_check
            check (health_status in ('unknown', 'healthy', 'unhealthy'));
        end if;
      end $$
    `.execute(db);

    await sql`
      alter table tool_definitions
      add column if not exists source_metadata jsonb not null default '{}'::jsonb
    `.execute(db);
  }
};
