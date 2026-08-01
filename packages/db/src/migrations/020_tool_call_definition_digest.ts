import { sql } from "kysely";
import type { Migration } from "./types";

/**
 * Converge databases that recorded migration 012 before tool-call definition
 * digests were added to its source definition during development.
 */
export const toolCallDefinitionDigest: Migration = {
  id: "020_tool_call_definition_digest",
  async up(db) {
    await sql`
      alter table tool_calls
      add column if not exists definition_digest text
    `.execute(db);
    await sql`
      update tool_calls tc
      set definition_digest = coalesce(
        definition.definition_digest,
        'legacy:' || tc.id::text
      )
      from tool_definitions definition
      where tc.definition_digest is null
        and definition.id = tc.tool_definition_id
    `.execute(db);
    await sql`
      update tool_calls
      set definition_digest = 'legacy:' || id::text
      where definition_digest is null
    `.execute(db);
    await sql`
      alter table tool_calls
      alter column definition_digest set not null
    `.execute(db);
  }
};
