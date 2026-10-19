import "server-only";
import postgres from "postgres";
import { PostgresWorkbookRepository } from "../persistence/postgres-workbook-repository.ts";
import { createWorkbookHandler } from "./workbook-handler.ts";
import { SupabaseAuthenticator } from "./supabase-auth.ts";
import { runtimeConfiguration } from "./runtime-configuration.ts";

let sql: postgres.Sql | undefined;

function database(config: ReturnType<typeof runtimeConfiguration>): postgres.Sql {
  if (sql) return sql;
  // Do not cache role authorization here: repository transactions verify the actual pooled session.
  sql = postgres(config.databaseUrl, { prepare: false, max: 5, connect_timeout: 10, idle_timeout: 20,
    ssl: config.ssl, onnotice: () => {} });
  return sql;
}

export async function handleWorkbookRequest(request: Request): Promise<Response> {
  // Lazy: builds do not connect to Auth/Postgres and do not require runtime secrets.
  const auth = { async authenticate(req: Request) {
    const config = runtimeConfiguration(process.env);
    return new SupabaseAuthenticator(config.authUrl, config.publicKey).authenticate(req);
  } };
  return createWorkbookHandler(auth, actorId => new PostgresWorkbookRepository(database(runtimeConfiguration(process.env)), actorId))(request);
}
