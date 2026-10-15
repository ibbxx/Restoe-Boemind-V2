import { ServiceUnavailableError, SupabaseAuthenticator } from "./supabase-auth.ts";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

// URL validation is not role authorization; every repository transaction also runs enterRuntimeRole.
export function runtimeConfiguration(env: Readonly<Record<string, string | undefined>>) {
  const required = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"] as const;
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw new ServiceUnavailableError("Missing environment: " + missing.join(", "));
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new ServiceUnavailableError("TLS verification must remain enabled.");
  let database: URL, auth: SupabaseAuthenticator;
  try {
    database = new URL(env.DATABASE_URL!);
    auth = new SupabaseAuthenticator(env.SUPABASE_URL!, env.SUPABASE_PUBLISHABLE_KEY!);
  } catch { throw new ServiceUnavailableError("Invalid Supabase/PostgreSQL configuration."); }
  if (!["postgres:", "postgresql:"].includes(database.protocol) || database.hash || auth.url.pathname !== "/") {
    throw new ServiceUnavailableError("Invalid Supabase/PostgreSQL URL configuration.");
  }
  if ([...database.searchParams].some(([name, value]) => name !== "sslmode" || value !== "verify-full")) {
    throw new ServiceUnavailableError("TLS verification must remain enabled; URL parameters may only specify sslmode=verify-full.");
  }
  const local = localHosts.has(database.hostname) && localHosts.has(auth.url.hostname);
  const project = /^([a-z0-9]+)\.supabase\.co$/.exec(auth.url.hostname)?.[1] ?? null;
  let username: string;
  try { username = decodeURIComponent(database.username); }
  catch { throw new ServiceUnavailableError("Invalid database username encoding."); }
  const pooler = database.hostname.endsWith(".pooler.supabase.com") && project !== null && username.endsWith("." + project);
  if (!local && (!project || (database.hostname !== `db.${project}.supabase.co` && !pooler))) {
    throw new ServiceUnavailableError("Database target does not match the Auth project.");
  }
  if (!local && (!database.username || !database.password)) throw new ServiceUnavailableError("Database credentials are not configured.");
  return { databaseUrl: database.href, authUrl: auth.url.origin, publicKey: auth.publicKey, project, pooler,
    ssl: local ? false as const : "verify-full" as const };
}
