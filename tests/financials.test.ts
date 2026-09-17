import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateFinancials } from "../src/financials.ts";

test("paid excludes transfers and confirmed transfer adjusts balance once", () => {
  const expenses = [
    { author_id: "me", amount_kopecks: 940000, shares: [{ user_id: "me", amount_kopecks: 235000 }] },
    { author_id: "other", amount_kopecks: 1540000, shares: [{ user_id: "me", amount_kopecks: 385000 }] },
  ];
  const transfer = { senderId: "other", receiverId: "me", amountKopecks: 200000, active: true };
  assert.deepEqual(calculateFinancials(expenses, [{ ...transfer, status: "pending" }], "me"), { total: 2480000, paid: 940000, balance: 320000 });
  assert.equal(calculateFinancials(expenses, [{ ...transfer, status: "sent" }], "me").balance, 320000);
  assert.equal(calculateFinancials(expenses, [{ ...transfer, status: "confirmed" }], "me").balance, 120000);
  assert.equal(calculateFinancials(expenses, [{ ...transfer, status: "confirmed", active: false }], "me").balance, 320000);
});
