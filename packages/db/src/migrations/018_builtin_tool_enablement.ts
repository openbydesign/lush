import { sql } from "kysely";
import type { Migration } from "./types";

/** Move built-in availability from the hidden catalog to individual tools. */
export const builtinToolEnablement: Migration = {
  id: "018_builtin_tool_enablement",
  async up(db) {
    await sql`
      update tool_connections
      set enabled = true,
          updated_at = now()
      where system_key = 'lush_builtin'
    `.execute(db);

    await sql`
      update tool_definitions
      set enabled = false,
          updated_at = now()
      where connection_id in (
        select id
        from tool_connections
        where system_key = 'lush_builtin'
      )
    `.execute(db);
  }
};
