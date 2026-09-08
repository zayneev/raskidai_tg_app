import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  validateInitData,
  sha256,
} from "../supabase/functions/_shared/auth.ts";
import { createHandler } from "../supabase/functions/_shared/handler.ts";
const botToken = "123456:test-token-for-tests-only";
const now = Math.floor(Date.now() / 1000);
function signed(fields: Record<string, string> = {}, token = botToken) {
  const params = new URLSearchParams({
    auth_date: String(now),
    user: JSON.stringify({
      id: 123456789012,
      first_name: "Анна",
      last_name: "Тест",
    }),
    query_id: "test-query",
    ...fields,
  });
  params.sort();
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret)
    .update([...params].map(([k, v]) => `${k}=${v}`).join("\n"))
    .digest("hex");
  params.set("hash", hash);
  return params.toString();
}
test("valid Telegram signature, Unicode, large ID and extra signed fields", async () => {
  assert.deepEqual(
    await validateInitData(signed({ signature: "future-field" }), botToken),
    { telegramId: 123456789012, displayName: "Анна Тест" },
  );
});
for (const [name, raw] of Object.entries({
  tampered: signed().replace("test-query", "forged"),
  wrongBot: signed({}, "different-token"),
  old: signed({ auth_date: String(now - 301) }),
  future: signed({ auth_date: String(now + 60) }),
  duplicate: `${signed()}&auth_date=${now}`,
  missingUser: signed({ user: "" }),
  missingDate: signed({ auth_date: "" }),
  malformedUser: signed({ user: "{" }),
  unsafeId: signed({
    user: JSON.stringify({ id: 9007199254740992, first_name: "A" }),
  }),
  emptyName: signed({ user: JSON.stringify({ id: 1, first_name: " " }) }),
  noHash: "auth_date=123",
}))
  test(`reject ${name}`, async () => {
    await assert.rejects(validateInitData(raw, botToken));
  });

test("HTTP login uses verified ID, protected lookup and logout use hash only", async () => {
  let savedHash = "";
  let revoked = false;
  const session = {
    user: { id: "server-user-id", displayName: "Анна Тест" },
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (name === "create_telegram_session") {
      assert.equal(args.p_telegram_id, 123456789012);
      savedHash = String(args.p_token_hash);
      return session;
    }
    assert.equal(args.p_token_hash, savedHash);
    if (name === "revoke_app_session") {
      revoked = true;
      return null;
    }
    return revoked ? null : session;
  };
  const options = { botToken, allowedOrigins: ["https://example.com"], rpc };
  const login = createHandler("telegram-auth", options);
  const result = await login(
    new Request("https://api.test/telegram-auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ initData: signed(), userId: "attacker" }),
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(
    result.headers.get("access-control-allow-origin"),
    "https://example.com",
  );
  assert.equal(result.headers.get("cache-control"), "no-store");
  const body = await result.json();
  assert.match(body.token, /^[a-f0-9]{64}$/);
  assert.equal(savedHash, await sha256(body.token));
  assert.notEqual(savedHash, body.token);
  const handler = createHandler("session", options);
  const request = (method = "GET") =>
    new Request("https://api.test/session?userId=attacker", {
      method,
      headers: { Authorization: `Bearer ${body.token}` },
    });
  assert.deepEqual(await (await handler(request())).json(), session);
  assert.equal((await handler(request("DELETE"))).status, 200);
  assert.equal((await handler(request())).status, 401);
});
test("unauthenticated/malformed requests never reach DB; unknown session rejected", async () => {
  let calls = 0;
  const options = {
    botToken,
    allowedOrigins: ["https://example.com"],
    rpc: async () => {
      calls++;
      return null;
    },
  };
  const login = createHandler("telegram-auth", options);
  const session = createHandler("session", options);
  assert.equal(
    (await session(new Request("https://api.test/session"))).status,
    401,
  );
  assert.equal(
    (
      await session(
        new Request("https://api.test/session", {
          headers: { Authorization: "Bearer forged" },
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await login(
        new Request("https://api.test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await login(
        new Request("https://api.test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: "forged" }),
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await login(
        new Request("https://api.test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "x".repeat(32769),
        }),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await login(
        new Request("https://api.test", {
          method: "OPTIONS",
          headers: { Origin: "https://evil.test" },
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await login(
        new Request("https://api.test", {
          method: "OPTIONS",
          headers: { Origin: "https://example.com" },
        }),
      )
    ).status,
    204,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await session(
        new Request("https://api.test/session", {
          headers: { Authorization: `Bearer ${"a".repeat(64)}` },
        }),
      )
    ).status,
    401,
  );
  assert.equal(calls, 1);
});
