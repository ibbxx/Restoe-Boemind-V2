import type { SaveRequest } from "../application/contracts.ts";

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
  let response: Response;
  try { response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", ...init.headers } }); }
  catch (cause) {
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw new Error("Permintaan terlalu lama. Perubahan yang belum disimpan tetap ada; coba lagi.");
    }
    throw new Error("Koneksi terputus. Perubahan yang belum disimpan tetap ada; coba lagi.");
  }
  if (response.status === 401 && refresh) {
    await api("/api/session", { method: "POST", body: JSON.stringify({ operation: "REFRESH" }) }, false);
    return api<T>(url, init, false);
  }
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.code ?? "REQUEST_FAILED");
  return data as T;
}
export function saveRequestBody(request: SaveRequest) { return JSON.stringify({ operation: "SAVE", request }); }
