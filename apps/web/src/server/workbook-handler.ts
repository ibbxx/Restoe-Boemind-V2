import type { PostgresRevisionRepository } from "../persistence/postgres-revision-repository.ts";
import { AccessDeniedError } from "../persistence/postgres-revision-repository.ts";
import { RuntimeDatabaseRoleError } from "../persistence/runtime-role.ts";
import { object, requireCondition } from "../domain/validation.ts";
import { parseProfile } from "../domain/profiles.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";
import type { SessionAuthenticator } from "./supabase-auth.ts";
import { AuthenticationError, ServiceUnavailableError } from "./supabase-auth.ts";

type Repository = Pick<PostgresRevisionRepository, "save" | "restore" | "head" | "get" | "history" | "replay" |
  "listProjects" | "listAnalyses" | "calculate" | "runs" | "latestRun">;
type RepositoryFactory = (actorId: Awaited<ReturnType<SessionAuthenticator["authenticate"]>>) => Repository;
const MAX_BODY = 5 * 1024 * 1024;
class PayloadTooLargeError extends Error {}

async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new TypeError("Expected application/json.");
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new PayloadTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Missing JSON body.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BODY) { await reader.cancel(); throw new PayloadTooLargeError(); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
}

export function createWorkbookHandler(auth: SessionAuthenticator, factory: RepositoryFactory) {
  return async function handle(request: Request): Promise<Response> {
    const respond = (data: unknown, status = 200) => Response.json(data, { status,
      headers: { "Cache-Control": "private, no-store", "Vary": "Authorization" } });
    try {
      if (!["GET", "POST"].includes(request.method)) return respond({ code: "METHOD_NOT_ALLOWED" }, 405);
      const actorId = await auth.authenticate(request), repository = factory(actorId);
      if (request.method === "GET") {
        const params = new URL(request.url).searchParams;
        const analysisId = params.get("analysisId"), revisionId = params.get("revisionId");
        switch (params.get("view") ?? "head") {
          case "projects": return respond(await repository.listProjects());
          case "analyses": return respond(await repository.listAnalyses(params.get("projectId")));
          case "head": return respond(await repository.head(analysisId));
          case "history": return respond(await repository.history(analysisId));
          case "revision": return respond(await repository.get(analysisId, revisionId));
          case "replay": return respond(await repository.replay(analysisId, revisionId));
          case "runs": return respond(await repository.runs(analysisId));
          case "latest-run": return respond(await repository.latestRun(analysisId, parseProfile(params.get("profile"))));
          default: throw new TypeError("Unknown view.");
        }
      }
      const command = object(await body(request), ["operation", "request"]);
      if (command.operation === "SAVE" || command.operation === "RESTORE") {
        const outcome = command.operation === "SAVE" ? await repository.save(command.request, actorId) : await repository.restore(command.request, actorId);
        return respond(outcome, outcome.status === "SAVED" ? 200 : outcome.status === "CONFLICT" ? 409 :
          outcome.code === "CONFIRMATION_UNAVAILABLE" ? 422 : 400);
      }
      requireCondition(command.operation === "CALCULATE", "Unknown operation.");
      const calculation = object(command.request, ["analysisId", "revisionId", "configuration"]);
      const result = await repository.calculate(calculation.analysisId, calculation.revisionId, calculation.configuration as EngineConfiguration);
      return respond(result, result.status === "STALE_RUN" ? 409 : 200);
    } catch (error) {
      if (error instanceof AuthenticationError) return respond({ code: "UNAUTHENTICATED" }, 401);
      if (error instanceof AccessDeniedError) return respond({ code: "NOT_FOUND_OR_FORBIDDEN" }, 403);
      if (error instanceof ServiceUnavailableError || error instanceof RuntimeDatabaseRoleError) return respond({ code: "SERVICE_UNAVAILABLE" }, 503);
      if (error instanceof PayloadTooLargeError) return respond({ code: "PAYLOAD_TOO_LARGE" }, 413);
      if (error instanceof TypeError || error instanceof SyntaxError) return respond({ code: "INVALID_REQUEST" }, 400);
      // Never return driver errors, SQL, URLs, tokens or connection credentials to clients.
      return respond({ code: "STORAGE_UNAVAILABLE" }, 503);
    }
  };
}
