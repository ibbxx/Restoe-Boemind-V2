import { SupabaseAuthenticator, AuthenticationError, ServiceUnavailableError } from "./supabase-auth.ts";

const accessCookie = "procurement_access", refreshCookie = "procurement_refresh";
export function sessionCookie(request: Request, name = accessCookie): string | null {
  const part = request.headers.get("cookie")?.split(";").map(p => p.trim()).find(p => p.startsWith(name + "="));
  if (!part) return null;
  try { return decodeURIComponent(part.slice(name.length + 1)); } catch { return null; }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    const parsed = new URL(origin), url = new URL(request.url);
    // Next's internal request URL may use localhost when the browser requested the loopback address.
    return parsed.origin === origin && parsed.protocol === url.protocol && parsed.host === (request.headers.get("host") ?? url.host);
  } catch { return false; }
}
export function withBrowserSession(request: Request): Request | Response {
  if (request.headers.has("authorization")) return request;
  if (request.method !== "GET" && !sameOrigin(request)) return Response.json({ code: "ORIGIN_REJECTED" }, { status: 403 });
  const token = sessionCookie(request);
  const headers = new Headers(request.headers);
  if (token) headers.set("authorization", "Bearer " + token);
  return new Request(request, { headers });
}

export function createSessionHandler(env: Readonly<Record<string, string | undefined>>, fetcher: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie" } });
    const setCookie = (result: Response, name: string, value: string, maxAge?: number) => {
      const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
      result.headers.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/${secure}${maxAge === undefined ? "" : "; Max-Age=" + maxAge}`);
    };
    const clear = (result: Response) => { setCookie(result, accessCookie, "", 0); setCookie(result, refreshCookie, "", 0); return result; };
    try {
      if (!["GET", "POST", "DELETE"].includes(request.method)) return response({ code: "METHOD_NOT_ALLOWED" }, 405);
      if (request.method !== "GET" && !sameOrigin(request)) return response({ code: "ORIGIN_REJECTED" }, 403);
      const auth = new SupabaseAuthenticator(env.SUPABASE_URL ?? "", env.SUPABASE_PUBLISHABLE_KEY ?? "", fetcher);
      const upstream = async (path: string, init: RequestInit) => {
        try { return await fetcher(new URL("/auth/v1/" + path, auth.url), {
          ...init, headers: { apikey: auth.publicKey, "Content-Type": "application/json", ...init.headers },
          cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) }); }
        catch { throw new ServiceUnavailableError(); }
      };
      const authJson = async (result: Response) => {
        try { return await result.json(); } catch { throw new ServiceUnavailableError(); }
      };
      if (request.method === "GET") {
        const headers = new Headers();
        const token = sessionCookie(request);
        const refreshToken = sessionCookie(request, refreshCookie);
        if (!token && !refreshToken) return response({ actorId: null });
        if (token) headers.set("authorization", "Bearer " + token);
        try {
          const actorId = await auth.authenticate(new Request(request.url, { headers }));
          return response({ actorId });
        } catch (error) {
          if (error instanceof AuthenticationError && !refreshToken) return clear(response({ actorId: null }));
          throw error;
        }
      }
      if (request.method === "DELETE") {
        let token = sessionCookie(request);
        const refreshToken = sessionCookie(request, refreshCookie);
        if (refreshToken) {
          const renewed = await upstream("token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) });
          if (renewed.status >= 500 || renewed.status === 429) return response({ code: "LOGOUT_UNAVAILABLE" }, 503);
          if (renewed.ok) {
            const session = await authJson(renewed);
            if (typeof session.access_token !== "string") throw new ServiceUnavailableError();
            token = session.access_token;
          }
        }
        if (token) {
          const revoked = await upstream("logout?scope=local", { method: "POST", headers: { Authorization: "Bearer " + token } });
          if (!revoked.ok && revoked.status !== 401 && revoked.status !== 403) return response({ code: "LOGOUT_UNAVAILABLE" }, 503);
        }
        return clear(response({ status: "SIGNED_OUT" }));
      }
      if (!request.headers.get("content-type")?.startsWith("application/json")) return response({ code: "INVALID_REQUEST" }, 400);
      const reader = request.body?.getReader();
      if (!reader) return response({ code: "INVALID_REQUEST" }, 400);
      let text = "", size = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.length;
          if (size > 16384) { await reader.cancel(); return response({ code: "PAYLOAD_TOO_LARGE" }, 413); }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      const body: unknown = JSON.parse(text);
      if (!body || typeof body !== "object" || !("operation" in body)) return response({ code: "INVALID_REQUEST" }, 400);
      const record = body as Record<string, unknown>;
      const refresh = body.operation === "REFRESH";
      if (!refresh && (body.operation !== "LOGIN" || !("email" in body) || typeof body.email !== "string" ||
        !("password" in body) || typeof body.password !== "string" || !body.email.trim() || !body.password)) return response({ code: "INVALID_REQUEST" }, 400);
      const refreshToken = sessionCookie(request, refreshCookie);
      if (refresh && !refreshToken) return clear(response({ code: "UNAUTHENTICATED" }, 401));
      const payload = refresh ? { refresh_token: refreshToken } : { email: String(record.email).trim(), password: String(record.password) };
      const result = await upstream("token?grant_type=" + (refresh ? "refresh_token" : "password"), { method: "POST", body: JSON.stringify(payload) });
      if (result.status >= 500 || result.status === 429) return response({ code: "AUTH_UNAVAILABLE" }, 503);
      if (!result.ok) {
        const rejection = await authJson(result);
        if (rejection?.message === "Invalid API key" || rejection?.message === "No API key found in request") throw new ServiceUnavailableError();
        return refresh ? clear(response({ code: "UNAUTHENTICATED" }, 401)) : response({ code: "INVALID_CREDENTIALS" }, 401);
      }
      const session = await authJson(result);
      if (typeof session.access_token !== "string" || typeof session.refresh_token !== "string") throw new ServiceUnavailableError();
      const actorId = await auth.authenticate(new Request(request.url, { headers: { authorization: "Bearer " + session.access_token } }));
      const output = response({ actorId });
      // Session cookies stay server-readable only; the browser never receives tokens in JSON or storage.
      setCookie(output, accessCookie, session.access_token); setCookie(output, refreshCookie, session.refresh_token);
      return output;
    } catch (error) {
      if (error instanceof AuthenticationError) return response({ code: "UNAUTHENTICATED" }, 401);
      if (error instanceof SyntaxError || error instanceof TypeError) return response({ code: "INVALID_REQUEST" }, 400);
      return response({ code: "AUTH_UNAVAILABLE" }, 503);
    }
  };
}
