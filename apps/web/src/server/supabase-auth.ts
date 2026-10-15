import { parseStableId } from "../domain/ids.ts";
import type { StableId } from "../domain/ids.ts";

export class AuthenticationError extends Error {}
export class ServiceUnavailableError extends Error {}
export interface SessionAuthenticator {
  authenticate(request: Request): Promise<StableId<"user">>;
}

export class SupabaseAuthenticator implements SessionAuthenticator {
  readonly url: URL;
  readonly publicKey: string;
  readonly fetcher: typeof fetch;
  constructor(url: string, publicKey: string, fetcher: typeof fetch = fetch) {
    try { this.url = new URL(url); }
    catch { throw new ServiceUnavailableError("Invalid Supabase public configuration."); }
    if ((this.url.protocol !== "https:" && !(this.url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(this.url.hostname))) ||
      this.url.username || this.url.password || this.url.search || this.url.hash || !publicKey || publicKey.startsWith("sb_secret_")) {
      throw new ServiceUnavailableError("Invalid Supabase public configuration.");
    }
    if (!publicKey.startsWith("sb_publishable_")) {
      try {
        const payload = JSON.parse(Buffer.from(publicKey.split(".")[1]!, "base64url").toString());
        const project = /^([a-z0-9]+)\.supabase\.co$/.exec(this.url.hostname)?.[1];
        if (payload.role !== "anon" || (project && payload.ref !== undefined && payload.ref !== project)) throw new Error();
      } catch { throw new ServiceUnavailableError("Expected Supabase publishable/anon key, never service-role credentials."); }
    }
    this.publicKey = publicKey; this.fetcher = fetcher;
  }
  async authenticate(request: Request): Promise<StableId<"user">> {
    const authorization = request.headers.get("authorization");
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) throw new AuthenticationError("A Supabase access token is required.");
    let response: Response;
    try {
      // Remote Auth validates the token; decoding JWT claims locally is not authentication.
      response = await this.fetcher(new URL("/auth/v1/user", this.url), { headers: { authorization, apikey: this.publicKey },
        cache: "no-store", signal: AbortSignal.timeout(10000), redirect: "error" });
    } catch { throw new ServiceUnavailableError("Supabase Auth unavailable."); }
    if (response.status >= 500 || response.status === 429) throw new ServiceUnavailableError("Supabase Auth unavailable.");
    if (!response.ok) {
      let message: unknown;
      try { message = (await response.json()).message; } catch { /* No raw upstream error is exposed. */ }
      if (message === "Invalid API key" || message === "No API key found in request") {
        throw new ServiceUnavailableError("Supabase API key configuration was rejected.");
      }
      throw new AuthenticationError("Supabase session is invalid or expired.");
    }
    try {
      const user: unknown = await response.json();
      if (!user || typeof user !== "object" || !("id" in user) || !("role" in user) || user.role !== "authenticated") throw new Error();
      return parseStableId<"user">(user.id);
    } catch { throw new AuthenticationError("Supabase did not return an authenticated user."); }
  }
}
