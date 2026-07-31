import { sql } from "kysely";
import type { Migration } from "./types";

/**
 * Tool gateway control-plane and invocation-plane state.
 *
 * `services/tools` is the only path from an agent to an external tool. These
 * tables keep connections, credentials, discovered definitions, calls, and
 * approvals attributable and independently governable. Secrets live only in the
 * encrypted envelope column; domain APIs never expose ciphertext or plaintext.
 */
export const toolGateway: Migration = {
  id: "012_tool_gateway",
  async up(db) {
    await sql`
      create table if not exists tool_connections (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id) on delete cascade,
        owner_user_id uuid references users(id) on delete cascade,
        source text not null check (source in ('mcp', 'openapi', 'native')),
        label text not null,
        endpoint_config jsonb not null default '{}'::jsonb,
        credential_mode text not null default 'none'
          check (credential_mode in ('none', 'organization', 'user_delegated')),
        enabled boolean not null default true,
        policy jsonb not null default '{}'::jsonb,
        catalog_version text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `.execute(db);

    // Org-scoped connections have owner_user_id = null; user-scoped connections
    // are private to one user within one organization. A partial unique index
    // keeps org-scoped labels unique while allowing per-user labels to repeat.
    await sql`
      create index if not exists tool_connections_org_idx
      on tool_connections(organization_id, owner_user_id)
    `.execute(db);

    await sql`
      create table if not exists tool_credential_bindings (
        id uuid primary key default gen_random_uuid(),
        connection_id uuid not null references tool_connections(id) on delete cascade,
        subject_user_id uuid references users(id) on delete cascade,
        encrypted_secret text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `.execute(db);

    // One binding per (connection, subject). A null subject is the org service
    // credential; treat it as a single distinguished row per connection.
    await sql`
      create unique index if not exists tool_credential_bindings_subject_idx
      on tool_credential_bindings(connection_id, subject_user_id)
      where subject_user_id is not null
    `.execute(db);
    await sql`
      create unique index if not exists tool_credential_bindings_service_idx
      on tool_credential_bindings(connection_id)
      where subject_user_id is null
    `.execute(db);

    await sql`
      create table if not exists tool_definitions (
        id uuid primary key default gen_random_uuid(),
        connection_id uuid not null references tool_connections(id) on delete cascade,
        external_name text not null,
        qualified_name text not null,
        title text not null default '',
        description text not null default '',
        input_schema jsonb not null default '{}'::jsonb,
        output_schema jsonb,
        annotations jsonb not null default '{}'::jsonb,
        definition_digest text not null,
        enabled boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `.execute(db);

    await sql`
      create unique index if not exists tool_definitions_connection_name_idx
      on tool_definitions(connection_id, external_name)
    `.execute(db);

    await sql`
      create table if not exists tool_calls (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id) on delete cascade,
        connection_id uuid not null references tool_connections(id) on delete cascade,
        tool_definition_id uuid references tool_definitions(id) on delete set null,
        run_id uuid,
        initiated_by_user_id uuid not null references users(id) on delete cascade,
        status text not null
          check (status in ('proposed', 'waiting_for_approval', 'running',
                            'succeeded', 'failed', 'denied', 'cancelled')),
        input jsonb not null default '{}'::jsonb,
        input_digest text not null,
        output_preview jsonb,
        output_ref text,
        is_error boolean not null default false,
        policy_decision jsonb,
        idempotency_key text,
        error_code text,
        error_message text,
        created_at timestamptz not null default now(),
        completed_at timestamptz
      )
    `.execute(db);

    await sql`
      create index if not exists tool_calls_org_created_idx
      on tool_calls(organization_id, created_at desc)
    `.execute(db);

    // Idempotency: a side-effecting call replayed with the same key must not
    // execute twice. Scoped to the connection to avoid cross-tool collisions.
    await sql`
      create unique index if not exists tool_calls_idempotency_idx
      on tool_calls(connection_id, idempotency_key)
      where idempotency_key is not null
    `.execute(db);

    await sql`
      create table if not exists tool_approvals (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id) on delete cascade,
        tool_call_id uuid references tool_calls(id) on delete cascade,
        connection_id uuid not null references tool_connections(id) on delete cascade,
        tool_definition_id uuid not null references tool_definitions(id) on delete cascade,
        run_id uuid,
        initiated_by_user_id uuid not null references users(id) on delete cascade,
        input_digest text not null,
        definition_digest text not null,
        scope text not null default 'once'
          check (scope in ('once', 'once_per_run', 'once_per_resource', 'every_call')),
        status text not null default 'pending'
          check (status in ('pending', 'approved', 'denied', 'expired')),
        decided_by_user_id uuid references users(id) on delete set null,
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        decided_at timestamptz
      )
    `.execute(db);

    await sql`
      create index if not exists tool_approvals_call_idx
      on tool_approvals(tool_call_id)
    `.execute(db);
  }
};
