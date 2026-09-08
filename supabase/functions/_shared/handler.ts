import {
  bearerToken,
  HttpError,
  newSessionToken,
  sha256,
  validateInitData,
} from "./auth.ts";

export type Rpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
type Options = { botToken: string; allowedOrigins: string[]; rpc: Rpc };
export function createHandler(
  kind: "telegram-auth" | "session",
  options: Options,
) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    if (origin && options.allowedOrigins.includes(origin))
      headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, content-type");
    headers.set(
      "Access-Control-Allow-Methods",
      kind === "telegram-auth" ? "POST, OPTIONS" : "GET, DELETE, OPTIONS",
    );
    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    try {
      if (origin && !options.allowedOrigins.includes(origin))
        throw new HttpError(403, "origin_not_allowed");
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      if (kind === "telegram-auth") {
        if (request.method !== "POST")
          throw new HttpError(405, "method_not_allowed");
        if (
          !request.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/json")
        )
          throw new HttpError(415, "json_required");
        // Read incrementally so chunked requests cannot bypass the body limit.
        const reader = request.body?.getReader();
        if (!reader) throw new HttpError(400, "invalid_body");
        let size = 0;
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 32768) {
            await reader.cancel();
            throw new HttpError(413, "body_too_large");
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        let body;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new HttpError(400, "invalid_body");
        }
        const identity = await validateInitData(
          body?.initData,
          options.botToken,
        );
        const token = newSessionToken();
        const result = await options.rpc("create_telegram_session", {
          p_telegram_id: identity.telegramId,
          p_display_name: identity.displayName,
          p_token_hash: await sha256(token),
        });
        return respond({ ...(result as object), token });
      }
      if (!["GET", "DELETE"].includes(request.method))
        throw new HttpError(405, "method_not_allowed");
      const hash = await sha256(bearerToken(request));
      // This lookup is the shared authorization boundary for future endpoints.
      const session = await options.rpc("get_app_session", {
        p_token_hash: hash,
      });
      if (!session) throw new HttpError(401, "unauthorized");
      if (request.method === "DELETE") {
        await options.rpc("revoke_app_session", { p_token_hash: hash });
        return respond({ ok: true });
      }
      return respond(session);
    } catch (error) {
      if (error instanceof HttpError)
        return respond({ error: error.code }, error.status);
      // Never log initData, Authorization, tokens, or database response bodies.
      console.error("Auth request failed");
      return respond({ error: "server_error" }, 500);
    }
  };
}
