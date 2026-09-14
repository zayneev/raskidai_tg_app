export type EventSummary = {
  id: string;
  title: string;
  description: string;
  creatorId: string;
  status: "draft" | "settled" | "completed";
  version: number;
  memberCount: number;
};
export type EventDetails = Omit<EventSummary, "memberCount"> & {
  members: { id: string; displayName: string; joinedAt: string }[];
  invitationActive: boolean;
};
const messages: Record<string, string> = {
  unauthorized:
    "Сессия истекла. Закройте приложение и откройте его заново из Telegram.",
  forbidden: "Недостаточно прав для этого действия.",
  not_found: "Мероприятие или приглашение недоступно.",
  invitation_invalid:
    "Ссылка отключена или обновлена. Попросите новую у создателя.",
  event_locked: "Мероприятие уже зафиксировано. Изменения недоступны.",
  event_full: "В мероприятии уже 30 участников.",
  creator_cannot_leave: "Создатель не может покинуть мероприятие.",
  member_has_expenses: "Нельзя выйти: вы связаны с расходами мероприятия.",
  version_conflict: "Данные мероприятия уже изменились. Обновите экран.",
  request_conflict:
    "Этот запрос уже выполнен с другими данными. Обновите список.",
  transfers_started:
    "Нельзя вернуться к редактированию: отправка переводов уже началась.",
  transfer_unavailable:
    "Этот перевод не относится к активному расчёту. Обновите экран.",
  invalid_transition:
    "Статус перевода уже изменился или это действие сейчас недоступно. Обновите экран.",
  invalid_input: "Проверьте введённые данные.",
};
import { requestJson, RequestFailure, sessionExpiredEvent } from "./resilience";

export { RequestFailure as EventApiError } from "./resilience";

const reads = new Set([
  "list",
  "get",
  "expenses.list",
  "expenses.history",
  "settlements.get",
  "history.list",
]);
const inFlightReads = new Map<string, Promise<unknown>>();
export async function eventRequest<T>(
  token: string,
  action: string,
  data: Record<string, unknown> = {},
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const safeRead = reads.has(action);
  const execute = async () => {
    const result = await requestJson<unknown>(
      `${import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, "")}/functions/v1/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...data, action }),
      },
      {
        signal: options.signal,
        safeRead,
        errorMessages: messages,
        onUnauthorized: () =>
          window.dispatchEvent(new Event(sessionExpiredEvent)),
      },
    );
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new RequestFailure(
        "invalid_response",
        "Сервер вернул некорректный ответ. Попробуйте обновить данные.",
        undefined,
        undefined,
        !safeRead,
      );
    return result as T;
  };
  if (!safeRead) return execute();
  // Component-scoped reads own their AbortSignal. Sharing such a promise would
  // let one unmount cancel a different consumer (notably in React StrictMode).
  if (options.signal) return execute();
  const key = `${token}:${action}:${JSON.stringify(data)}`;
  const existing = inFlightReads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = execute().finally(() => inFlightReads.delete(key));
  inFlightReads.set(key, promise);
  return promise;
}
