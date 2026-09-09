import test from "node:test";
import assert from "node:assert/strict";
import { parseRubles, rublesInput, formatMoney } from "../src/money.ts";
import { createEventsHandler } from "../supabase/functions/_shared/events.ts";
import { sha256 } from "../supabase/functions/_shared/auth.ts";
test("rubles parsed as exact integer kopecks without rounding", () => {
  for (const [input, expected] of [
    ["0,01", 1],
    ["1.1", 110],
    [" 123,45 ", 12345],
    ["999999999.99", 99999999999],
  ] as const)
    assert.equal(parseRubles(input), expected);
  for (const input of [
    "0",
    "-1",
    "1.001",
    "1e2",
    "Infinity",
    "1,",
    "1 000",
    "1000000000",
    "NaN",
    "",
  ])
    assert.equal(parseRubles(input), null);
  assert.equal(rublesInput(101), "1.01");
  assert.equal(formatMoney(101), "1,01 ₽");
});
test("expense HTTP routes all actions to transactional RPC and strips identity", async () => {
  const token = "a".repeat(64);
  for (const action of ["list", "history", "create", "update", "delete"]) {
    const data = {
      eventId: "event",
      expenseId: "expense",
      requestId: "request",
      version: 1,
      title: "Dinner",
      amountKopecks: 101,
      memberIds: ["one"],
    };
    const handler = createEventsHandler({
      allowedOrigins: [],
      rpc: async (name, args) => {
        assert.equal(name, "expense_action");
        assert.equal(args.p_action, action);
        assert.equal(args.p_token_hash, await sha256(token));
        assert.deepEqual(args.p_data, data);
        return { ok: true };
      },
    });
    const response = await handler(
      new Request("https://test/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: `expenses.${action}`,
          ...data,
          userId: "forged",
          authorId: "forged",
          shares: [100],
          currency: "USD",
        }),
      }),
    );
    assert.equal(response.status, 200);
  }
});
test("expense conflicts return 409 and missing session never invokes RPC", async () => {
  for (const error of ["version_conflict", "request_conflict"]) {
    const handler = createEventsHandler({
      allowedOrigins: [],
      rpc: async () => ({ error }),
    });
    assert.equal(
      (
        await handler(
          new Request("https://test/events", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${"a".repeat(64)}`,
              "Content-Type": "application/json",
            },
            body: '{"action":"expenses.update"}',
          }),
        )
      ).status,
      409,
    );
  }
  const handler = createEventsHandler({
    allowedOrigins: [],
    rpc: async () => {
      throw new Error("must not call");
    },
  });
  assert.equal(
    (await handler(new Request("https://test/events", { method: "POST" })))
      .status,
    401,
  );
});
