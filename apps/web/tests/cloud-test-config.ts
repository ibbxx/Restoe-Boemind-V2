import { runtimeConfiguration } from "../src/server/runtime-configuration.ts";

export class CloudConfigurationError extends Error {}

export function cloudTestConfig(env: Readonly<Record<string, string | undefined>>, requestWrites = false, connectivityOnly = false) {
  if (connectivityOnly && requestWrites) throw new CloudConfigurationError("Connectivity-only preflight cannot write.");
  if (connectivityOnly && !env.PREFLIGHT_DATABASE_URL?.trim()) throw new CloudConfigurationError("Missing environment: PREFLIGHT_DATABASE_URL");
  let config: ReturnType<typeof runtimeConfiguration>;
  // Diagnostic credentials never become the runtime DATABASE_URL or modify process.env.
  try { config = runtimeConfiguration(connectivityOnly ? { ...env, DATABASE_URL: env.PREFLIGHT_DATABASE_URL } : env); }
  catch (error) { throw new CloudConfigurationError(error instanceof Error ? error.message : "Invalid cloud configuration."); }
  const { project } = config;
  if (!project || config.ssl !== "verify-full") throw new CloudConfigurationError("Use official HTTPS project URL and PostgreSQL URL.");
  if (connectivityOnly && (!config.pooler || new URL(config.databaseUrl).port !== "5432")) {
    throw new CloudConfigurationError("Connectivity-only preflight requires a Shared Session Pooler URL on port 5432.");
  }
  if (requestWrites && (env.SUPABASE_CLOUD_ALLOW_WRITES !== "1" || env.SUPABASE_CLOUD_CONFIRM_PROJECT !== project)) {
    throw new CloudConfigurationError("Writes require explicit approval, SUPABASE_CLOUD_ALLOW_WRITES=1 and matching SUPABASE_CLOUD_CONFIRM_PROJECT.");
  }
  let migrationAuditUrl: string | undefined;
  if (!connectivityOnly && env.SUPABASE_MIGRATION_AUDIT_URL) {
    try {
      migrationAuditUrl = runtimeConfiguration({ ...env, DATABASE_URL: env.SUPABASE_MIGRATION_AUDIT_URL }).databaseUrl;
      const runtime = new URL(config.databaseUrl), audit = new URL(migrationAuditUrl);
      if (runtime.hostname !== audit.hostname || runtime.port !== audit.port || runtime.pathname !== audit.pathname) throw new Error();
    } catch { throw new CloudConfigurationError("Migration audit must target the same database with verified TLS."); }
  }
  return { ...config, project, connectivityOnly, migrationAuditUrl,
    tokenA: env.SUPABASE_TEST_ACCESS_TOKEN_A, tokenB: env.SUPABASE_TEST_ACCESS_TOKEN_B,
    analysisIdA: env.SUPABASE_CLOUD_ANALYSIS_ID_A, allowWrites: requestWrites };
}
