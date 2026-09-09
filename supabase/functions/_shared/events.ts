import { bearerToken, HttpError, newSessionToken, sha256 } from "./auth.ts";
import type { Rpc } from "./handler.ts";

const statuses: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invitation_invalid: 404,
  event_locked: 409,
  event_full: 409,
  creator_cannot_leave: 409,
  member_has_expenses: 409,
  version_conflict: 409,
  request_conflict: 409,
  invalid_input: 400,
  invalid_action: 400,
};
export function createEventsHandler(options: {
  allowedOrigins: string[];
  rpc: Rpc;
}) {
  return async (request: Request) => {
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    if (origin && options.allowedOrigins.includes(origin))
      headers.set("Access-Control-Allow-Origin", origin);
    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    try {
      if (origin && !options.allowedOrigins.includes(origin))
        throw new HttpError(403, "origin_not_allowed");
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      if (request.method !== "POST")
        throw new HttpError(405, "method_not_allowed");
      const hash = await sha256(bearerToken(request));
      if (
        !request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      )
        throw new HttpError(415, "json_required");
      const reader = request.body?.getReader();
      if (!reader) throw new HttpError(400, "invalid_input");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16384) {
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
        throw new HttpError(400, "invalid_input");
      }
      const action = body?.action;
      if (
        ![
          "list",
          "create",
          "get",
          "join",
          "rotate",
          "disable",
          "leave",
          "expenses.list",
          "expenses.history",
          "expenses.create",
          "expenses.update",
          "expenses.delete",
        ].includes(action)
      )
        throw new HttpError(400, "invalid_action");
      const data: Record<string, unknown> = {};
      // Explicit allowlist: caller cannot inject identity or a chosen invitation hash.
      if (action === "create")
        Object.assign(data, {
          title: body.title,
          description: body.description ?? "",
          requestId: body.requestId,
        });
      if (["get", "rotate", "disable", "leave"].includes(action)) {
        if (
          typeof body.eventId !== "string" ||
          !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.eventId)
        )
          throw new HttpError(400, "invalid_input");
        data.eventId = body.eventId;
      }
      const expenseAction = action.startsWith("expenses.");
      if (expenseAction) {
        for (const key of [
          "eventId",
          "expenseId",
          "requestId",
          "version",
          "title",
          "amountKopecks",
          "memberIds",
        ])
          if (body[key] !== undefined) data[key] = body[key];
      }
      let token: string | undefined;
      if (action === "join") {
        if (
          typeof body.invitation !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.invitation)
        )
          throw new HttpError(400, "invitation_invalid");
        data.invitationHash = await sha256(body.invitation);
      }
      if (action === "rotate") {
        token = newSessionToken();
        data.invitationHash = await sha256(token);
      }
      const result = (await options.rpc(
        expenseAction ? "expense_action" : "event_action",
        {
          p_token_hash: hash,
          p_action: expenseAction ? action.slice("expenses.".length) : action,
          p_data: data,
        },
      )) as Record<string, unknown>;
      if (typeof result?.error === "string")
        return respond({ error: result.error }, statuses[result.error] ?? 500);
      return respond(token ? { ...result, invitation: token } : result);
    } catch (error) {
      if (error instanceof HttpError)
        return respond({ error: error.code }, error.status);
      return respond({ error: "server_error" }, 500);
    }
  };
}
