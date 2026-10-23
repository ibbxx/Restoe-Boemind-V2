import type { AnalysisPage, SaveRequest } from "../application/contracts.ts";
import type { StableId } from "../domain/ids.ts";

export interface SessionInfo { readonly actorId: StableId<"user"> | null }
let sessionFlight: Promise<SessionInfo> | null = null;
let refreshFlight: Promise<unknown> | null = null;
let sessionController = new AbortController();

export type ProjectListItem = { id: string; name: string };
type WorkbookList = ProjectListItem[] | AnalysisPage;
type ListEntry = { projectId: string | null; value: WorkbookList | undefined; savedAt: number;
  pending: Promise<WorkbookList | undefined> | null };
const listCache = new Map<string, ListEntry>();
const LIST_TTL = 30000;
let prefetchFlight: Promise<WorkbookList | undefined> | null = null;

export function cachedWorkbookList<T extends WorkbookList>(actorId: string, url: string): T | undefined {
  return listCache.get(`${actorId}:${url}`)?.value as T | undefined;
}

export function readWorkbookList<T extends WorkbookList>(actorId: string, url: string): {
  cached: T | undefined; pending: Promise<T | undefined> | null;
} {
  const parsed = new URL(url, "http://localhost");
  const params = parsed.searchParams;
  const view = params.get("view");
  if (parsed.pathname !== "/api/workbook" || (view !== "projects" && view !== "analyses") ||
    (view === "analyses" && !params.get("projectId"))) throw new TypeError("Only workbook lists may be cached.");
  const key = `${actorId}:${url}`;
  let entry = listCache.get(key);
  if (!entry) entry = { projectId: view === "analyses" ? params.get("projectId") : null, value: undefined, savedAt: 0, pending: null };
  listCache.delete(key); listCache.set(key, entry);
  const pages = [...listCache].filter(([, value]) => value.projectId !== null);
  for (const [oldest] of pages.slice(0, Math.max(0, pages.length - 20))) listCache.delete(oldest);
  if (!entry.pending && (entry.value === undefined || Date.now() - entry.savedAt >= LIST_TTL)) {
    const target = entry;
    const pending = api<T>(url).then(value => {
      // Invalidated requests must not repopulate the cache or update their old callers.
      if (listCache.get(key) !== target) return undefined;
      target.value = value; target.savedAt = Date.now();
      return value;
    }, cause => {
      if (cause instanceof ApiError && (cause.code === "SESSION_CHANGED" || cause.code === "UNAUTHENTICATED")) throw cause;
      if (listCache.get(key) !== target) return undefined;
      throw cause;
    }).finally(() => { if (target.pending === pending) target.pending = null; });
    entry.pending = pending;
  }
  return { cached: entry.value as T | undefined, pending: entry.pending as Promise<T | undefined> | null };
}

export function invalidateWorkbookLists(projectId: string, projectsChanged = false) {
  for (const [key, entry] of listCache) {
    if (entry.projectId === projectId || (projectsChanged && entry.projectId === null)) listCache.delete(key);
  }
}

export function prefetchWorkbookList(actorId: string, url: string): Promise<WorkbookList | undefined> | null {
  if (prefetchFlight) return null;
  const { pending } = readWorkbookList(actorId, url);
  if (!pending) return null;
  prefetchFlight = pending;
  void pending.finally(() => { if (prefetchFlight === pending) prefetchFlight = null; }).catch(() => {});
  return pending;
}

export function invalidateSessionRequests() {
  sessionController.abort();
  sessionController = new AbortController();
  sessionFlight = null;
  refreshFlight = null;
  listCache.clear();
  prefetchFlight = null;
}

// Share pending requests only; never retain an authenticated result after it settles.
export function readSession(): Promise<SessionInfo> {
  if (!sessionFlight) {
    const flight = api<SessionInfo>("/api/session").finally(() => { if (sessionFlight === flight) sessionFlight = null; });
    sessionFlight = flight;
  }
  return sessionFlight;
}

function refreshSession(): Promise<unknown> {
  if (!refreshFlight) {
    const flight = api("/api/session", { method: "POST", body: JSON.stringify({ operation: "REFRESH" }) }, false)
      .finally(() => { if (refreshFlight === flight) refreshFlight = null; });
    refreshFlight = flight;
  }
  return refreshFlight;
}

const messages: Record<string, string> = {
  INVALID_CREDENTIALS: "Email atau kata sandi salah.", UNAUTHENTICATED: "Sesi berakhir. Silakan masuk kembali.",
  STALE_VERSION: "Data tersimpan sudah berubah. Draft Anda dipertahankan. Muat ulang setelah meninjau perubahan di tab lain.",
  AUTH_UNAVAILABLE: "Layanan autentikasi tidak tersedia. Coba lagi.", SERVICE_UNAVAILABLE: "Layanan belum tersedia. Coba lagi.",
  STORAGE_UNAVAILABLE: "Penyimpanan tidak tersedia. Draft tetap ada; coba simpan lagi.",
  STORAGE_UPGRADE_REQUIRED: "Pembaruan penyimpanan belum selesai. Hubungi pengelola aplikasi.",
  IDEMPOTENCY_CONFLICT: "Permintaan simpan tidak sesuai. Perubahan Anda tetap ada; perbarui input sebelum mencoba lagi.",
  INVALID_REQUEST: "Data tidak valid. Periksa input Anda.", NOT_FOUND_OR_FORBIDDEN: "Data tidak ditemukan atau tidak dapat diakses.",
};
export class ApiError extends Error {
  readonly code: string;
  constructor(code: string) { super(messages[code] ?? "Operasi gagal. Coba lagi."); this.code = code; }
}
export async function api<T>(url: string, init: RequestInit = {}, refresh = true): Promise<T> {
  const sessionSignal = sessionController.signal;
  let response: Response;
  try { response = await fetch(url, { ...init, cache: "no-store",
    signal: AbortSignal.any([sessionSignal, AbortSignal.timeout(30000), ...(init.signal ? [init.signal] : [])]),
    headers: { "Content-Type": "application/json", ...init.headers } }); }
  catch (cause) {
    if (sessionSignal.aborted) throw new ApiError("SESSION_CHANGED");
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw new Error("Permintaan terlalu lama. Perubahan yang belum disimpan tetap ada; coba lagi.");
    }
    throw new Error("Koneksi terputus. Perubahan yang belum disimpan tetap ada; coba lagi.");
  }
  if (sessionSignal.aborted) throw new ApiError("SESSION_CHANGED");
  if (response.status === 401 && refresh) {
    await refreshSession();
    if (sessionSignal.aborted) throw new ApiError("SESSION_CHANGED");
    return api<T>(url, init, false);
  }
  let data;
  try { data = await response.json(); }
  catch (cause) {
    if (sessionSignal.aborted) throw new ApiError("SESSION_CHANGED");
    throw cause;
  }
  if (sessionSignal.aborted) throw new ApiError("SESSION_CHANGED");
  if (!response.ok) {
    if (response.status === 401) listCache.clear();
    throw new ApiError(data.code ?? "REQUEST_FAILED");
  }
  return data as T;
}
export function saveRequestBody(request: SaveRequest) { return JSON.stringify({ operation: "SAVE", request }); }
