import type { SaveRequest } from "../application/contracts.ts";

const messages: Record<string, string> = {
  INVALID_CREDENTIALS: "Email atau kata sandi salah.", UNAUTHENTICATED: "Sesi berakhir. Silakan masuk kembali.",
  STALE_REVISION: "Revisi sudah berubah. Draft Anda dipertahankan. Muat ulang setelah meninjau perubahan di tab lain.",
  CONFIRMATION_UNAVAILABLE: "Finalisasi belum tersedia: kebijakan bisnis belum disahkan.",
  AUTH_UNAVAILABLE: "Layanan autentikasi tidak tersedia. Coba lagi.", SERVICE_UNAVAILABLE: "Layanan belum tersedia. Coba lagi.",
  STORAGE_UNAVAILABLE: "Penyimpanan tidak tersedia. Draft tetap ada; coba simpan lagi.",
  INVALID_REQUEST: "Data tidak valid. Periksa input Anda.", NOT_FOUND_OR_FORBIDDEN: "Data tidak ditemukan atau tidak dapat diakses.",
};
export class ApiError extends Error {
  readonly code: string;
  constructor(code: string) { super(messages[code] ?? "Operasi gagal. Coba lagi."); this.code = code; }
}
export async function api<T>(url: string, init: RequestInit = {}, refresh = true): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", ...init.headers } }); }
  catch { throw new Error("Koneksi terputus. Draft tetap ada; coba lagi."); }
  if (response.status === 401 && refresh) {
    await api("/api/session", { method: "POST", body: JSON.stringify({ operation: "REFRESH" }) }, false);
    return api<T>(url, init, false);
  }
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.code ?? "REQUEST_FAILED");
  return data as T;
}
export function post<T>(operation: string, request: unknown) {
  return api<T>("/api/workbook", { method: "POST", body: JSON.stringify({ operation, request }) });
}
export function saveRequestBody(request: SaveRequest) { return JSON.stringify({ operation: "SAVE", request }); }
