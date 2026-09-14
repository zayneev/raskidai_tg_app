export type RequestFailureKind =
  | "offline"
  | "timeout"
  | "cancelled"
  | "network"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "bad_request"
  | "server"
  | "invalid_response";

const statusMessages: Record<number, string> = {
  401: "Сессия истекла. Выполните вход через Telegram ещё раз.",
  403: "У вас больше нет прав для этого действия.",
  404: "Запрошенные данные недоступны или были удалены.",
  409: "Данные изменились на сервере. Обновите экран.",
};

export class RequestFailure extends Error {
  kind: RequestFailureKind;
  status: number | undefined;
  code: string | undefined;
  ambiguous: boolean;
  constructor(
    kind: RequestFailureKind,
    message: string,
    status?: number,
    code?: string,
    ambiguous = false,
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  safeRead?: boolean;
  retryDelays?: number[];
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  errorMessages?: Record<string, string>;
  onUnauthorized?: () => void;
  isOnline?: () => boolean;
};

function online() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function failureForStatus(
  status: number,
  code: string | undefined,
  messages: Record<string, string>,
) {
  const kind: RequestFailureKind =
    status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status >= 500
              ? "server"
              : "bad_request";
  const fallback =
    status >= 500
      ? "Сервер временно недоступен. Результат изменения мог сохраниться."
      : (statusMessages[status] ?? "Проверьте введённые данные.");
  return new RequestFailure(
    kind,
    (code && messages[code]) || fallback,
    status,
    code,
    status >= 500,
  );
}

export async function requestJson<T>(
  url: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<T> {
  const delays = options.safeRead ? (options.retryDelays ?? [250, 750]) : [];
  const fetcher = options.fetcher ?? fetch;
  const sleeper = options.sleep ?? wait;
  let attempt = 0;
  while (true) {
    if (!(options.isOnline ?? online)())
      throw new RequestFailure(
        "offline",
        "Нет подключения к интернету. Данные и форма сохранены.",
        undefined,
        undefined,
        true,
      );
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("Timeout", "TimeoutError")),
      options.timeoutMs ?? 15000,
    );
    const combined = new AbortController();
    const abort = (event: Event) =>
      combined.abort((event.target as AbortSignal).reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    timeout.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetcher(url, { ...init, signal: combined.signal });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new RequestFailure(
          "invalid_response",
          "Сервер вернул некорректный ответ. Попробуйте обновить данные.",
          response.status,
          undefined,
          !options.safeRead,
        );
      }
      if (!response.ok) {
        const code =
          body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : undefined;
        const failure = failureForStatus(
          response.status,
          code,
          options.errorMessages ?? {},
        );
        if (failure.kind === "unauthorized") options.onUnauthorized?.();
        throw failure;
      }
      return body as T;
    } catch (reason) {
      let failure: RequestFailure;
      if (reason instanceof RequestFailure) failure = reason;
      else if (options.signal?.aborted)
        failure = new RequestFailure("cancelled", "Запрос отменён.");
      else if (timeout.signal.aborted)
        failure = new RequestFailure(
          "timeout",
          "Сервер не ответил вовремя. Результат изменения пока неизвестен.",
          undefined,
          undefined,
          true,
        );
      else
        failure = new RequestFailure(
          "network",
          "Связь с сервером прервалась. Результат изменения пока неизвестен.",
          undefined,
          undefined,
          true,
        );
      const retryable = ["network", "timeout", "server"].includes(failure.kind);
      if (options.safeRead && retryable && attempt < delays.length) {
        try {
          await sleeper(delays[attempt++], options.signal);
        } catch {
          throw new RequestFailure("cancelled", "Запрос отменён.");
        }
        continue;
      }
      throw failure;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      timeout.signal.removeEventListener("abort", abort);
    }
  }
}

export function isAmbiguousMutationFailure(reason: unknown) {
  return reason instanceof RequestFailure && reason.ambiguous;
}

export function shouldKeepPendingMutation(reason: unknown) {
  return (
    isAmbiguousMutationFailure(reason) ||
    (reason instanceof RequestFailure && reason.kind === "unauthorized")
  );
}

export const sessionExpiredEvent = "raskidai:session-expired";
