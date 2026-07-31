import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import { optionalNumberEnv, requiredEnvValue, envValue } from "@lush/config/env";
import { Pool } from "pg";
import type { Database } from "./schema";

let sharedDb: Kysely<Database> | undefined;

export type DatabaseService =
  | "authz"
  | "inference"
  | "sessions"
  | "events"
  | "api";

export function createDb(options: { databaseUrl?: string; service?: DatabaseService } = {}) {
  const connectionString = options.databaseUrl ?? getDatabaseUrl(options.service);

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: optionalNumberEnv("LUSH_DB_POOL_SIZE", 10)
      })
    }),
    // JSON columns are application payloads, not database identifiers. In
    // particular, externally supplied JSON Schemas must retain property names
    // such as `search_queries` exactly as declared by their tool provider.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })]
  });
}

export function getDb() {
  sharedDb ??= createDb();
  return sharedDb;
}

export async function closeDb() {
  if (!sharedDb) {
    return;
  }

  await sharedDb.destroy();
  sharedDb = undefined;
}

export function getDatabaseUrl(service?: DatabaseService) {
  const serviceEnvName = service
    ? `${service.toUpperCase()}_DATABASE_URL`
    : undefined;
  const url =
    (serviceEnvName ? envValue(serviceEnvName) : undefined) ??
    requiredEnvValue("DATABASE_URL");

  return url;
}
