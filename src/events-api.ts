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
  forbidden: "Это действие доступно только создателю.",
  not_found: "Мероприятие или приглашение недоступно.",
  invitation_invalid:
    "Ссылка отключена или обновлена. Попросите новую у создателя.",
  event_locked: "Мероприятие уже зафиксировано. Изменения недоступны.",
  event_full: "В мероприятии уже 30 участников.",
  creator_cannot_leave: "Создатель не может покинуть мероприятие.",
  member_has_expenses: "Нельзя выйти: вы связаны с расходами мероприятия.",
  invalid_input: "Проверьте введённые данные.",
};
export async function eventRequest<T>(
  token: string,
  action: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, "")}/functions/v1/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...data, action }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new Error("Нет связи с сервером. Проверьте интернет и повторите.");
  }
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      messages[body.error] ??
        "Не удалось выполнить действие. Попробуйте ещё раз.",
    );
  return body as T;
}
