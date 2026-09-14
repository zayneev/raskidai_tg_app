import test from "node:test";
import assert from "node:assert/strict";
import { smokeCheck } from "../scripts/smoke-check.ts";

test("production smoke is read-only and verifies every backend version header", async () => {
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const malformed =
      request.url.endsWith("/telegram-auth") &&
      (await request.clone().text()) === "{";
    const status =
      request.url.endsWith("/session") || request.url.endsWith("/events")
        ? 401
        : malformed
          ? 400
          : 401;
    return new Response(JSON.stringify({ error: "expected" }), {
      status,
      headers: { "X-Raskidai-Backend-Version": "8" },
    });
  };
  const results = await smokeCheck("https://example.supabase.co/", fetcher);
  assert.equal(results.length, 4);
  assert.ok(
    requests.every(
      (request) => request.method === "GET" || request.method === "POST",
    ),
  );
  assert.ok(requests.every((request) => !request.headers.has("authorization")));
});

test("production smoke fails closed on unexpected backend version", async () => {
  await assert.rejects(
    smokeCheck(
      "https://example.supabase.co",
      async () =>
        new Response("{}", {
          status: 401,
          headers: { "X-Raskidai-Backend-Version": "7" },
        }),
    ),
    /expected backend 8/,
  );
});
