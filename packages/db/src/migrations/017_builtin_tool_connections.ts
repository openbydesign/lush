import { sql } from "kysely";
import type { Migration } from "./types";

/** Materialize code-owned tools as one non-deletable connection per organization. */
export const builtinToolConnections: Migration = {
  id: "017_builtin_tool_connections",
  async up(db) {
    await sql`
      alter table tool_connections
      add column if not exists system_key text
    `.execute(db);

    // PostgreSQL permits multiple nulls in a unique index, so user-managed
    // connections remain unconstrained while each system catalog is singular.
    await sql`
      create unique index if not exists tool_connections_org_system_key_idx
      on tool_connections(organization_id, system_key)
    `.execute(db);

    // Definitions are synchronized from the in-process registry on read. This
    // row makes the disabled built-in catalog visible immediately after upgrade.
    await sql`
      insert into tool_connections (
        organization_id,
        owner_user_id,
        source,
        system_key,
        label,
        endpoint_config,
        credential_mode,
        enabled,
        policy,
        catalog_version,
        catalog_acknowledged_version,
        catalog_changed,
        health_status,
        created_at,
        updated_at
      )
      select
        organizations.id,
        null,
        'native',
        'lush_builtin',
        'Built-in tools',
        '{}'::jsonb,
        'none',
        false,
        '{}'::jsonb,
        null,
        null,
        false,
        'unknown',
        now(),
        now()
      from organizations
      where not exists (
        select 1
        from tool_connections
        where tool_connections.organization_id = organizations.id
          and tool_connections.system_key = 'lush_builtin'
      )
    `.execute(db);
  }
};
