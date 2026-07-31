import { sql } from "kysely";
import {
  builtinLushAgentId,
  builtinLushRevisionDigest,
  builtinLushRevisionId
} from "../schema";
import type { Migration } from "./types";

/**
 * Durable managed-agent, environment, run, and sequenced-event projection.
 *
 * PostgreSQL is authoritative for product-visible state. Provider/workflow
 * handles are opaque implementation details and never become public ids.
 */
export const agentRuns: Migration = {
  id: "013_agent_runs",
  async up(db) {
    await sql`
      create table if not exists managed_agents (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid references organizations(id) on delete cascade,
        slug text not null,
        name text not null,
        system_owned boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check ((system_owned and organization_id is null) or
               (not system_owned and organization_id is not null))
      )
    `.execute(db);
    await sql`
      create unique index if not exists managed_agents_system_slug_idx
      on managed_agents(slug) where organization_id is null
    `.execute(db);
    await sql`
      create unique index if not exists managed_agents_org_slug_idx
      on managed_agents(organization_id, slug) where organization_id is not null
    `.execute(db);

    await sql`
      create table if not exists managed_agent_revisions (
        id uuid primary key default gen_random_uuid(),
        agent_id uuid not null references managed_agents(id) on delete cascade,
        version integer not null check (version >= 1),
        instructions text not null,
        model_policy jsonb not null default '{}'::jsonb,
        execution_profile text not null check (execution_profile in ('chat', 'code', 'work')),
        limits jsonb not null default '{}'::jsonb,
        digest text not null,
        created_at timestamptz not null default now(),
        published_at timestamptz not null default now(),
        unique(agent_id, version),
        unique(agent_id, digest)
      )
    `.execute(db);

    await sql`
      create table if not exists agent_installations (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id) on delete cascade,
        agent_id uuid not null references managed_agents(id) on delete cascade,
        owner_user_id uuid references users(id) on delete cascade,
        status text not null default 'active' check (status in ('active', 'disabled')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `.execute(db);
    await sql`
      create unique index if not exists agent_installations_org_agent_idx
      on agent_installations(organization_id, agent_id) where owner_user_id is null
    `.execute(db);
    await sql`
      create unique index if not exists agent_installations_user_agent_idx
      on agent_installations(organization_id, owner_user_id, agent_id)
      where owner_user_id is not null
    `.execute(db);

    await sql`
      create table if not exists agent_installation_revisions (
        id uuid primary key default gen_random_uuid(),
        installation_id uuid not null references agent_installations(id) on delete cascade,
        agent_revision_id uuid not null references managed_agent_revisions(id) on delete restrict,
        parent_installation_revision_id uuid references agent_installation_revisions(id) on delete restrict,
        additional_instructions text not null default '',
        capability_policy jsonb not null default '{}'::jsonb,
        model_override jsonb,
        digest text not null,
        created_at timestamptz not null default now(),
        unique(installation_id, digest)
      )
    `.execute(db);

    // Immutable built-in revision. Future prompt changes add a new revision;
    // this migration and historical runs must never be rewritten in place.
    await sql`
      insert into managed_agents
        (id, organization_id, slug, name, system_owned)
      values
        (${builtinLushAgentId}::uuid, null, 'lush', 'Lush', true)
      on conflict (id) do nothing
    `.execute(db);
    await sql`
      insert into managed_agent_revisions
        (id, agent_id, version, instructions, model_policy,
         execution_profile, limits, digest)
      values (
        ${builtinLushRevisionId}::uuid,
        ${builtinLushAgentId}::uuid,
        1,
        ${`You are Lush, a concise and practical AI agent inside the Lush app.\n\nAnswer directly, ask clarifying questions when needed, and avoid claiming tool\naccess until tools are explicitly connected.\n`},
        '{"workspaceMode":"chat"}'::jsonb,
        'chat',
        '{"wallClockMs":120000,"maxOutputBytes":8000000}'::jsonb,
        ${builtinLushRevisionDigest}
      )
      on conflict (id) do nothing
    `.execute(db);

    await sql`
      insert into agent_installations
        (organization_id, agent_id, owner_user_id, status)
      select id, ${builtinLushAgentId}::uuid, null, 'active'
      from organizations
      on conflict do nothing
    `.execute(db);
    await sql`
      insert into agent_installation_revisions
        (installation_id, agent_revision_id, additional_instructions,
         capability_policy, model_override, digest)
      select ai.id, ${builtinLushRevisionId}::uuid, '', '{}'::jsonb, null,
             ${builtinLushRevisionDigest}
      from agent_installations ai
      where ai.agent_id = ${builtinLushAgentId}::uuid
        and ai.owner_user_id is null
      on conflict do nothing
    `.execute(db);

    await sql`
      alter table session_threads
      add column if not exists agent_installation_id uuid
        references agent_installations(id) on delete restrict
    `.execute(db);
    await sql`
      alter table session_messages
      add column if not exists superseded_at timestamptz
    `.execute(db);
    await sql`
      alter table session_threads
      add column if not exists agent_revision_id uuid
        references managed_agent_revisions(id) on delete restrict
    `.execute(db);
    await sql`
      update session_threads st
      set agent_installation_id = ai.id,
          agent_revision_id = ${builtinLushRevisionId}::uuid
      from agent_installations ai
      where st.organization_id = ai.organization_id
        and st.agent_id = 'lush-chat'
        and ai.agent_id = ${builtinLushAgentId}::uuid
        and ai.owner_user_id is null
        and (st.agent_installation_id is null or st.agent_revision_id is null)
    `.execute(db);

    await sql`
      create table if not exists agent_environments (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id) on delete cascade,
        owner_user_id uuid not null references users(id) on delete cascade,
        session_id uuid not null references session_threads(id) on delete cascade,
        profile text not null check (profile in ('chat', 'code', 'work')),
        status text not null check (status in ('provisioning', 'ready', 'running',
          'idle', 'hibernated', 'failed', 'destroyed')),
        isolation_provider text not null,
        backend_handle text,
        image_digest text not null,
        limits jsonb not null default '{}'::jsonb,
        lease_expires_at timestamptz,
        retention_until timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        destroyed_at timestamptz
      )
    `.execute(db);
    await sql`
      create index if not exists agent_environments_session_idx
      on agent_environments(organization_id, owner_user_id, session_id, created_at desc)
    `.execute(db);

    await sql`
      create table if not exists agent_runs (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id) on delete cascade,
        session_id uuid not null references session_threads(id) on delete cascade,
        origin_message_id uuid not null references session_messages(id) on delete restrict,
        assistant_message_id uuid references session_messages(id) on delete set null,
        initiated_by_user_id uuid not null references users(id) on delete restrict,
        agent_revision_id uuid not null references managed_agent_revisions(id) on delete restrict,
        environment_id uuid not null references agent_environments(id) on delete restrict,
        status text not null check (status in ('queued', 'running',
          'waiting_for_approval', 'needs_acknowledgment', 'completed', 'failed', 'cancelled')),
        purpose text not null default 'chat' check (purpose in ('chat', 'title')),
        idempotency_key text not null,
        start_digest text not null,
        capability_digest text not null,
        configuration_digest text not null,
        configuration jsonb not null,
        isolation_provider text not null,
        untrusted_content_ingested boolean not null default false,
        limits jsonb not null default '{}'::jsonb,
        model_selection text not null default '',
        error_code text,
        error_message text,
        lease_owner text,
        lease_expires_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        started_at timestamptz,
        completed_at timestamptz,
        cancelled_at timestamptz,
        unique(organization_id, initiated_by_user_id, session_id, idempotency_key)
      )
    `.execute(db);
    await sql`
      create unique index if not exists agent_runs_one_active_per_session_idx
      on agent_runs(session_id)
      where status in ('queued', 'running', 'waiting_for_approval', 'needs_acknowledgment')
    `.execute(db);
    await sql`
      create index if not exists agent_runs_owner_created_idx
      on agent_runs(organization_id, initiated_by_user_id, created_at desc)
    `.execute(db);
    await sql`
      create index if not exists agent_runs_recovery_idx
      on agent_runs(status, lease_expires_at)
      where status in ('queued', 'running')
    `.execute(db);

    await sql`
      alter table session_threads
      add column if not exists current_run_id uuid references agent_runs(id) on delete set null
    `.execute(db);

    await sql`
      create table if not exists agent_run_installation_revisions (
        run_id uuid not null references agent_runs(id) on delete cascade,
        installation_revision_id uuid not null references agent_installation_revisions(id) on delete restrict,
        organization_id uuid not null references organizations(id) on delete cascade,
        primary key (run_id, installation_revision_id)
      )
    `.execute(db);

    await sql`
      create table if not exists agent_run_capabilities (
        id uuid primary key default gen_random_uuid(),
        run_id uuid not null unique references agent_runs(id) on delete cascade,
        organization_id uuid not null references organizations(id) on delete cascade,
        principal_user_id uuid not null references users(id) on delete restrict,
        snapshot jsonb not null,
        digest text not null,
        revoked_at timestamptz,
        created_at timestamptz not null default now()
      )
    `.execute(db);

    await sql`
      create table if not exists agent_run_events (
        id uuid primary key default gen_random_uuid(),
        run_id uuid not null references agent_runs(id) on delete cascade,
        organization_id uuid not null references organizations(id) on delete cascade,
        sequence integer not null check (sequence >= 1),
        type text not null,
        payload jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        unique(run_id, sequence)
      )
    `.execute(db);
    await sql`
      create index if not exists agent_run_events_resume_idx
      on agent_run_events(run_id, sequence)
    `.execute(db);

    await sql`
      create table if not exists agent_run_artifacts (
        id uuid primary key default gen_random_uuid(),
        run_id uuid not null references agent_runs(id) on delete cascade,
        organization_id uuid not null references organizations(id) on delete cascade,
        artifact_id text not null,
        kind text not null,
        created_at timestamptz not null default now(),
        unique(run_id, artifact_id)
      )
    `.execute(db);

    await sql`
      create table if not exists agent_run_acknowledgments (
        id uuid primary key default gen_random_uuid(),
        run_id uuid not null references agent_runs(id) on delete cascade,
        organization_id uuid not null references organizations(id) on delete cascade,
        tool_call_id uuid not null references tool_calls(id) on delete restrict,
        decided_by_user_id uuid not null references users(id) on delete restrict,
        decision text not null check (decision in ('retry', 'abandon')),
        input_digest text not null,
        tool_definition_digest text not null,
        created_at timestamptz not null default now(),
        unique(run_id, tool_call_id)
      )
    `.execute(db);

    await sql`
      alter table tool_calls
      add constraint tool_calls_run_id_fkey
      foreign key (run_id) references agent_runs(id) on delete set null
    `.execute(db);
    await sql`
      alter table tool_calls drop constraint if exists tool_calls_status_check
    `.execute(db);
    await sql`
      alter table tool_calls add constraint tool_calls_status_check
      check (status in ('proposed', 'waiting_for_approval', 'running',
                        'succeeded', 'failed', 'denied', 'outcome_unknown',
                        'cancelled'))
    `.execute(db);
    await sql`
      alter table tool_approvals
      add constraint tool_approvals_run_id_fkey
      foreign key (run_id) references agent_runs(id) on delete set null
    `.execute(db);
  }
};
