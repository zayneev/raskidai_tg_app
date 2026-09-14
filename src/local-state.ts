const PREFIX = "raskidai:v1:";
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

type Envelope<T> = {
  version: 1;
  userId: string;
  eventId: string;
  operation: string;
  kind: "draft" | "pending";
  updatedAt: number;
  expiresAt: number;
  data: T;
};

function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function part(value: string) {
  return encodeURIComponent(value);
}

export function localStateKey(
  userId: string,
  eventId: string | null,
  operation: string,
  kind: "draft" | "pending",
) {
  return `${PREFIX}${part(userId)}:${part(eventId ?? "global")}:${part(operation)}:${kind}`;
}

export function saveLocalState<T>(
  userId: string,
  eventId: string | null,
  operation: string,
  kind: "draft" | "pending",
  data: T,
  now = Date.now(),
) {
  const storage = store();
  if (!storage) return;
  const envelope: Envelope<T> = {
    version: 1,
    userId,
    eventId: eventId ?? "global",
    operation,
    kind,
    updatedAt: now,
    expiresAt: now + (kind === "draft" ? DRAFT_TTL_MS : PENDING_TTL_MS),
    data,
  };
  try {
    storage.setItem(
      localStateKey(userId, eventId, operation, kind),
      JSON.stringify(envelope),
    );
  } catch {
    // Storage can be unavailable or full in a WebView; the form still stays in memory.
  }
}

export function loadLocalState<T>(
  userId: string,
  eventId: string | null,
  operation: string,
  kind: "draft" | "pending",
  validate: (value: unknown) => value is T,
  now = Date.now(),
): T | null {
  const storage = store();
  const key = localStateKey(userId, eventId, operation, kind);
  if (!storage) return null;
  try {
    const parsed = JSON.parse(
      storage.getItem(key) ?? "null",
    ) as Envelope<unknown> | null;
    if (
      !parsed ||
      parsed.version !== 1 ||
      parsed.userId !== userId ||
      parsed.eventId !== (eventId ?? "global") ||
      parsed.operation !== operation ||
      parsed.kind !== kind ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= now ||
      !validate(parsed.data)
    ) {
      storage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function clearLocalState(
  userId: string,
  eventId: string | null,
  operation: string,
  kind: "draft" | "pending",
) {
  try {
    store()?.removeItem(localStateKey(userId, eventId, operation, kind));
  } catch {
    // Nothing else to clean up.
  }
}

export function clearUserLocalState(userId: string) {
  const storage = store();
  if (!storage) return;
  const marker = `${PREFIX}${part(userId)}:`;
  try {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(marker)) storage.removeItem(key);
    }
  } catch {
    // Best effort on logout; keys remain isolated by internal user ID.
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
