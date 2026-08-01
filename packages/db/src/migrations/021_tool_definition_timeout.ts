import { sql } from "kysely";
import type { Migration } from "./types";

/** Add an optional invocation deadline override without changing tool identity. */
export const toolDefinitionTimeout: Migration = {
  id: "021_tool_definition_timeout",
  async up(db) {
    await sql`
      alter table tool_definitions
      add column if not exists timeout_ms integer
    `.execute(db);
    await sql`
      alter table tool_definitions
      drop constraint if exists tool_definitions_timeout_ms_check
    `.execute(db);
    await sql`
      alter table tool_definitions
      add constraint tool_definitions_timeout_ms_check
      check (timeout_ms is null or timeout_ms between 1000 and 90000)
    `.execute(db);
  }
};
