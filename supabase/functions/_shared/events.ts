import { bearerToken, HttpError, newSessionToken, sha256 } from "./auth.ts";
import type { Rpc } from "./handler.ts";

const encoder = new TextEncoder();
async function invitationToken(
  secret: string,
  eventId: string,
  requestId: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`invitation:${eventId}:${requestId}`),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

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
  transfers_started: 409,
  transfer_unavailable: 409,
  invalid_transition: 409,
  invalid_input: 400,
  invalid_action: 400,
};
export function createEventsHandler(options: {
  allowedOrigins: string[];
  rpc: Rpc;
  invitationSecret?: string;
  backendVersion?: string;
}) {
  return async (request: Request) => {
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "X-Raskidai-Backend-Version": options.backendVersion ?? "development",
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
          "settlements.get",
          "settlements.preview",
          "settlements.settle",
          "settlements.cancel",
          "transfers.send",
          "transfers.confirm",
          "transfers.not_received",
          "history.list",
        ].includes(action)
      )
        throw new HttpError(400, "invalid_action");
      const data: Record<string, unknown> = {};
      // Explicit allowlist: caller cannot inject identity or a chosen invitation hash.
      if (action === "create")
        Object.assign(data, {
          title: body.title,
          description: body.description ?? "",
          category: body.category ?? "other",
          eventDate: body.eventDate ?? null,
          requestId: body.requestId,
        });
      if (
        ["get", "rotate", "disable", "leave", "history.list"].includes(action)
      ) {
        if (
          typeof body.eventId !== "string" ||
          !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.eventId)
        )
          throw new HttpError(400, "invalid_input");
        data.eventId = body.eventId;
      }
      if (["join", "rotate", "disable", "leave"].includes(action)) {
        if (
          body.requestId !== undefined &&
          (typeof body.requestId !== "string" ||
            !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
              body.requestId,
            ))
        )
          throw new HttpError(400, "invalid_input");
        if (body.requestId !== undefined) data.requestId = body.requestId;
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
      const settlementAction = action.startsWith("settlements.");
      if (settlementAction) {
        const allowedKeys =
          action === "settlements.preview"
            ? ["eventId"]
            : ["eventId", "requestId", "eventVersion"];
        for (const key of allowedKeys)
          if (body[key] !== undefined) data[key] = body[key];
      }
      const transferAction = action.startsWith("transfers.");
      if (transferAction) {
        for (const key of [
          "eventId",
          "transferId",
          "requestId",
          "eventVersion",
        ])
          if (body[key] !== undefined) data[key] = body[key];
      }
      const historyAction = action === "history.list";
      if (historyAction) {
        if (body.limit !== undefined) data.limit = body.limit;
        if (body.cursor !== undefined) data.cursor = body.cursor;
      }
      let token: string | undefined;
      if (action === "create") {
        if (
          typeof body.requestId !== "string" ||
          !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.requestId)
        )
          throw new HttpError(400, "invalid_input");
        if (!options.invitationSecret)
          throw new Error("Missing invitation secret");
        token = await invitationToken(
          options.invitationSecret,
          "create",
          body.requestId,
        );
        data.invitationHash = await sha256(token);
      }
      if (action === "join") {
        if (
          typeof body.invitation !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.invitation)
        )
          throw new HttpError(400, "invitation_invalid");
        data.invitationHash = await sha256(body.invitation);
      }
      if (action === "rotate") {
        if (typeof body.requestId === "string") {
          if (!options.invitationSecret)
            throw new Error("Missing invitation secret");
          token = await invitationToken(
            options.invitationSecret,
            String(data.eventId),
            body.requestId,
          );
        } else {
          // Compatibility for the already-published stage 6 frontend.
          token = newSessionToken();
        }
        data.invitationHash = await sha256(token);
      }
      const result = (await options.rpc(
        historyAction
          ? "event_history_action"
          : action === "settlements.preview"
            ? "settlement_preview_action"
            : expenseAction
              ? "expense_action"
              : transferAction
                ? "transfer_action"
                : settlementAction
                  ? "settlement_action"
                  : "event_action",
        {
          p_token_hash: hash,
          ...(historyAction || action === "settlements.preview"
            ? {}
            : {
                p_action: expenseAction
                  ? action.slice("expenses.".length)
                  : transferAction
                    ? action.slice("transfers.".length)
                    : settlementAction
                      ? action.slice("settlements.".length)
                      : action,
              }),
          p_data: data,
        },
      )) as Record<string, unknown>;
      if (typeof result?.error === "string")
        return respond({ error: result.error }, statuses[result.error] ?? 500);
      return respond(
        token && (result?.ok || result?.eventId)
          ? { ...result, invitation: token }
          : result,
      );
    } catch (error) {
      if (error instanceof HttpError)
        return respond({ error: error.code }, error.status);
      return respond({ error: "server_error" }, 500);
    }
  };
}
