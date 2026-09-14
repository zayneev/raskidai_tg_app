import test from "node:test";
import assert from "node:assert/strict";
import { RequestFailure, requestJson } from "../src/resilience.ts";
import {
  clearUserLocalState,
  DRAFT_TTL_MS,
  loadLocalState,
  localStateKey,
  saveLocalState,
} from "../src/local-state.ts";
import { listenForSafeRefresh } from "../src/lifecycle.ts";

test("safe reads retry bounded transient failures; mutations never auto-retry", async () => {
  let readCalls = 0;
  const read = await requestJson<{ ok: boolean }>(
    "https://example.test/read",
    {},
    {
      safeRead: true,
      retryDelays: [1, 2],
      sleep: async () => {},
      fetcher: async () => {
        readCalls++;
        return new Response(
          JSON.stringify(
            readCalls < 3 ? { error: "server_error" } : { ok: true },
          ),
          { status: readCalls < 3 ? 503 : 200 },
        );
      },
    },
  );
  assert.deepEqual(read, { ok: true });
  assert.equal(readCalls, 3);

  let mutationCalls = 0;
  await assert.rejects(
    requestJson(
      "https://example.test/write",
      { method: "POST" },
      {
        fetcher: async () => {
          mutationCalls++;
          return new Response(JSON.stringify({ error: "server_error" }), {
            status: 500,
          });
        },
      },
    ),
    (reason: unknown) =>
      reason instanceof RequestFailure &&
      reason.kind === "server" &&
      reason.ambiguous,
  );
  assert.equal(mutationCalls, 1);
});

test("timeout aborts the transport and is classified as ambiguous", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = requestJson(
    "https://example.test/slow",
    {},
    {
      timeoutMs: 50,
      fetcher: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    },
  );
  t.mock.timers.tick(50);
  await assert.rejects(
    request,
    (reason: unknown) =>
      reason instanceof RequestFailure &&
      reason.kind === "timeout" &&
      reason.ambiguous,
  );
});

test("offline and caller cancellation have distinct failures", async () => {
  await assert.rejects(
    requestJson("https://example.test/offline", {}, { isOnline: () => false }),
    (reason: unknown) =>
      reason instanceof RequestFailure && reason.kind === "offline",
  );
  const controller = new AbortController();
  const request = requestJson(
    "https://example.test/cancel",
    {},
    {
      signal: controller.signal,
      fetcher: async (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          ),
        ),
    },
  );
  controller.abort();
  await assert.rejects(
    request,
    (reason: unknown) =>
      reason instanceof RequestFailure && reason.kind === "cancelled",
  );
});

test("foreground and restored network trigger reads only while visible", () => {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  let online = false;
  let visible = true;
  let onlineChanges = 0;
  let refreshes = 0;
  const cleanup = listenForSafeRefresh({
    windowTarget,
    documentTarget,
    isOnline: () => online,
    isVisible: () => visible,
    onOnlineChange: () => onlineChanges++,
    onRefresh: () => refreshes++,
  });
  windowTarget.dispatchEvent(new Event("offline"));
  assert.deepEqual([onlineChanges, refreshes], [1, 0]);
  online = true;
  visible = false;
  windowTarget.dispatchEvent(new Event("online"));
  assert.deepEqual([onlineChanges, refreshes], [2, 0]);
  visible = true;
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(refreshes, 1);
  cleanup();
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(refreshes, 1);
});

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test("local state is versioned, scoped, expires and removes corruption", () => {
  const localStorage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });
  const valid = (value: unknown): value is { title: string } =>
    !!value &&
    typeof value === "object" &&
    typeof (value as { title?: unknown }).title === "string";
  saveLocalState(
    "user-a",
    "event-a",
    "expense",
    "draft",
    { title: "Такси" },
    10,
  );
  assert.deepEqual(
    loadLocalState("user-a", "event-a", "expense", "draft", valid, 11),
    { title: "Такси" },
  );
  assert.equal(
    loadLocalState("user-b", "event-a", "expense", "draft", valid, 11),
    null,
  );
  assert.equal(
    loadLocalState(
      "user-a",
      "event-a",
      "expense",
      "draft",
      valid,
      10 + DRAFT_TTL_MS,
    ),
    null,
  );
  const key = localStateKey("user-a", null, "create", "pending");
  localStorage.setItem(key, "not json");
  assert.equal(
    loadLocalState("user-a", null, "create", "pending", valid),
    null,
  );
  assert.equal(localStorage.getItem(key), null);

  saveLocalState("user-a", null, "one", "draft", { title: "A" });
  saveLocalState("user-b", null, "one", "draft", { title: "B" });
  clearUserLocalState("user-a");
  assert.equal(loadLocalState("user-a", null, "one", "draft", valid), null);
  assert.deepEqual(loadLocalState("user-b", null, "one", "draft", valid), {
    title: "B",
  });
  Reflect.deleteProperty(globalThis, "window");
});
