import test from "node:test";
import assert from "node:assert/strict";
import { createEventsHandler } from "../supabase/functions/_shared/events.ts";
import { sha256 } from "../supabase/functions/_shared/auth.ts";
import { launchInvitation, invitationLink } from "../src/invitations.ts";
const token = "a".repeat(64);
const id = "00000000-0000-4000-8000-000000000001";
const request = (body: unknown, headers = {}) =>
  new Request("https://example.test/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
test("event handler hashes session and strips forged identity", async () => {
  const handler = createEventsHandler({
    allowedOrigins: [],
    rpc: async (name, args) => {
      assert.equal(name, "event_action");
      assert.equal(args.p_token_hash, await sha256(token));
      assert.deepEqual(args.p_data, { eventId: id });
      return { event: { id } };
    },
  });
  const response = await handler(
    request({
      action: "get",
      eventId: id,
      userId: id,
      invitationHash: "forged",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("join accepts only invitation capability, hashes it on server", async () => {
  const handler = createEventsHandler({
    allowedOrigins: [],
    rpc: async (_, args) => {
      assert.deepEqual(args.p_data, { invitationHash: await sha256(token) });
      return { eventId: id };
    },
  });
  assert.equal(
    (await handler(request({ action: "join", invitation: token }))).status,
    200,
  );
  assert.equal(
    (await handler(request({ action: "join", invitation: "bad" }))).status,
    400,
  );
});
test("rotation generates random tokens and never exposes hash", async () => {
  const hashes: string[] = [];
  const handler = createEventsHandler({
    allowedOrigins: [],
    rpc: async (_, args) => {
      hashes.push((args.p_data as { invitationHash: string }).invitationHash);
      return { ok: true };
    },
  });
  const first = await (
    await handler(request({ action: "rotate", eventId: id }))
  ).json();
  const second = await (
    await handler(request({ action: "rotate", eventId: id }))
  ).json();
  assert.match(first.invitation, /^[a-f0-9]{64}$/);
  assert.notEqual(first.invitation, second.invitation);
  assert.equal(hashes[0], await sha256(first.invitation));
  assert.equal(first.invitationHash, undefined);
});
test("business errors retain HTTP semantics", async () => {
  for (const [error, status] of [
    ["unauthorized", 401],
    ["forbidden", 403],
    ["not_found", 404],
    ["event_full", 409],
    ["invitation_invalid", 404],
    ["creator_cannot_leave", 409],
    ["member_has_expenses", 409],
    ["event_locked", 409],
  ] as const) {
    const handler = createEventsHandler({
      allowedOrigins: [],
      rpc: async () => ({ error }),
    });
    assert.equal((await handler(request({ action: "list" }))).status, status);
  }
});
test("rejects missing auth, invalid method, origin, malformed and oversized JSON before RPC", async () => {
  const handler = createEventsHandler({
    allowedOrigins: ["https://allowed.test"],
    rpc: async () => {
      assert.fail("RPC should not run");
    },
  });
  assert.equal(
    (await handler(request({ action: "list" }, { Authorization: "" }))).status,
    401,
  );
  assert.equal(
    (
      await handler(
        request({ action: "list" }, { Origin: "https://evil.test" }),
      )
    ).status,
    403,
  );
  assert.equal(
    (await handler(new Request("https://example.test"))).status,
    405,
  );
  assert.equal((await handler(request({ action: "other" }))).status, 400);
  assert.equal(
    (await handler(request({ action: "get", eventId: "bad" }))).status,
    400,
  );
  assert.equal(
    (await handler(request({ action: "create", title: "x".repeat(17000) })))
      .status,
    413,
  );
  const malformed = new Request("https://example.test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: "{",
  });
  assert.equal((await handler(malformed)).status, 400);
  const preflight = await handler(
    new Request("https://example.test", {
      method: "OPTIONS",
      headers: { Origin: "https://allowed.test" },
    }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "https://allowed.test",
  );
});
test("unknown RPC failure returns generic error without secrets", async () => {
  const handler = createEventsHandler({
    allowedOrigins: [],
    rpc: async () => {
      throw new Error(token);
    },
  });
  const response = await handler(request({ action: "list" }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "server_error" });
});
test("Telegram launch parsing uses start_param with fallback, validates capability", () => {
  assert.equal(launchInvitation(`start_param=invite_${token}`, ""), token);
  assert.equal(
    launchInvitation("", `?tgWebAppStartParam=invite_${token}`),
    token,
  );
  assert.equal(
    launchInvitation("start_param=bad", `?tgWebAppStartParam=invite_${token}`),
    null,
  );
  assert.equal(launchInvitation("", "?startapp=garbage"), null);
  assert.equal(
    invitationLink(token),
    `https://t.me/raskidai_app_bot?startapp=invite_${token}`,
  );
});
