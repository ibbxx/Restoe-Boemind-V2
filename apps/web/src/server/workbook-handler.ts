import type { PostgresWorkbookRepository } from "../persistence/postgres-workbook-repository.ts";
import { AccessDeniedError } from "../persistence/postgres-workbook-repository.ts";
import { RuntimeDatabaseRoleError, WorkbookUpgradeRequiredError } from "../persistence/runtime-role.ts";
import { object, requireCondition } from "../domain/validation.ts";
import type { SessionAuthenticator } from "./supabase-auth.ts";
import { AuthenticationError, ServiceUnavailableError } from "./supabase-auth.ts";

type Repository = Pick<PostgresWorkbookRepository, "save" | "current" | "listProjects" | "listAnalyses" | "deleteAnalysis" | "deleteProject" | "updateAnalysis"> & { readonly timings?: Readonly<Record<string, number>> };
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
    const started = performance.now();
    let authDuration = 0, repository: Repository | undefined;
    const respond = (data: unknown, status = 200) => {
      const response = Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "Vary": "Authorization" } });
      const timings = { auth: authDuration, ...repository?.timings, total: performance.now() - started };
      response.headers.set("Server-Timing", Object.entries(timings).filter(([, duration]) => Number.isFinite(duration))
        .map(([name, duration]) => `${name};dur=${duration.toFixed(2)}`).join(", "));
      return response;
    };
    try {
      if (!["GET", "POST", "DELETE"].includes(request.method)) return respond({ code: "METHOD_NOT_ALLOWED" }, 405);
      const actorId = await auth.authenticate(request);
      authDuration = performance.now() - started;
      repository = factory(actorId);
      if (request.method === "GET") {
        const params = new URL(request.url).searchParams;
        const analysisId = params.get("analysisId");
        switch (params.get("view") ?? "current") {
          case "projects": return respond(await repository.listProjects());
          case "analyses": return respond(await repository.listAnalyses(params.get("projectId")));
          case "current": return respond(await repository.current(analysisId));
          default: throw new TypeError("Unknown view.");
        }
      }
      if (request.method === "DELETE") {
        const raw = await body(request);
        requireCondition(raw !== null && typeof raw === "object" && !Array.isArray(raw), "Expected an object.");
        const operation = (raw as Record<string, unknown>).operation;
        requireCondition(operation === "DELETE_ANALYSIS" || operation === "DELETE_PROJECT", "Unknown operation.");
        if (operation === "DELETE_ANALYSIS") {
          const command = object(raw, ["operation", "analysisId"]);
          return respond(await repository.deleteAnalysis(command.analysisId, actorId));
        }
        const command = object(raw, ["operation", "projectId"]);
        return respond(await repository.deleteProject(command.projectId, actorId));
      }
      const raw = await body(request);
      requireCondition(raw !== null && typeof raw === "object" && !Array.isArray(raw), "Expected an object.");
      if ((raw as Record<string, unknown>).operation === "UPDATE_ANALYSIS") {
        const command = object(raw, ["operation", "analysisId", "name", "status"]);
        return respond(await repository.updateAnalysis(command.analysisId, actorId, command.name, command.status));
      }
      const command = object(raw, ["operation", "request"]);
      requireCondition(command.operation === "SAVE", "Unknown operation.");
      const outcome = await repository.save(command.request, actorId);
      return respond(outcome, outcome.status === "SAVED" ? 200 : outcome.status === "CONFLICT" ? 409 : 400);
    } catch (error) {
      if (error instanceof AuthenticationError) return respond({ code: "UNAUTHENTICATED" }, 401);
      if (error instanceof AccessDeniedError) return respond({ code: "NOT_FOUND_OR_FORBIDDEN" }, 403);
      if (error instanceof WorkbookUpgradeRequiredError) return respond({ code: "STORAGE_UPGRADE_REQUIRED" }, 503);
      if (error instanceof ServiceUnavailableError || error instanceof RuntimeDatabaseRoleError) return respond({ code: "SERVICE_UNAVAILABLE" }, 503);
      if (error instanceof PayloadTooLargeError) return respond({ code: "PAYLOAD_TOO_LARGE" }, 413);
      if (error instanceof TypeError || error instanceof SyntaxError) return respond({ code: "INVALID_REQUEST" }, 400);
      // Never return driver errors, SQL, URLs, tokens or connection credentials to clients.
      return respond({ code: "STORAGE_UNAVAILABLE" }, 503);
    }
  };
}
