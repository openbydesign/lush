import { sql } from "kysely";
import type { Migration } from "./types";

/** Remove the placeholder clock tool from already-synchronized organizations. */
export const retireCurrentTimeTool: Migration = {
  id: "019_retire_current_time_tool",
  async up(db) {
    await sql`
      delete from tool_definitions
      where external_name = 'current_time'
        and connection_id in (
          select id
          from tool_connections
          where system_key = 'lush_builtin'
        )
    `.execute(db);
  }
};
