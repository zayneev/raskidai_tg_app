import { useCallback, useEffect, useRef, useState } from "react";
import { eventRequest } from "./events-api";
import { formatMoney } from "./money";
import type { RequestFailure } from "./resilience";

type HistoryItem = {
  id: string;
  source: "expense" | "settlement" | "transfer";
  action: string;
  actorName: string;
  occurredAt: string;
  before: Record<string, unknown> | string | null;
  after: Record<string, unknown> | string | null;
  details: Record<string, unknown>;
};
type HistoryPage = {
  items: HistoryItem[];
  nextCursor: { occurredAt: string; id: string; source: string } | null;
};

const actionNames: Record<string, string> = {
  "expense.create": "Добавлен расход",
  "expense.update": "Изменён расход",
  "expense.delete": "Удалён расход",
  "settlement.settle": "Расчёт зафиксирован",
  "settlement.cancel": "Расчёт отменён",
  "settlement.complete": "Мероприятие завершено",
  "transfer.sent": "Перевод отмечен отправленным",
  "transfer.confirmed": "Получение перевода подтверждено",
  "transfer.not_received": "Перевод отмечен неполученным",
};

function summary(item: HistoryItem) {
  if (item.source === "transfer") {
    const sender = String(item.details.senderName ?? "Отправитель");
    const receiver = String(item.details.receiverName ?? "получатель");
    const amount = Number(item.details.amountKopecks);
    return `${sender} → ${receiver}${Number.isSafeInteger(amount) ? ` · ${formatMoney(amount)}` : ""}`;
  }
  const expenseSummary = (snapshot: HistoryItem["before"]) => {
    if (!snapshot || typeof snapshot !== "object" || !("title" in snapshot))
      return null;
    const amount = Number(snapshot.amount_kopecks);
    return `${String(snapshot.title)}${Number.isSafeInteger(amount) ? ` · ${formatMoney(amount)}` : ""}`;
  };
  if (item.source === "expense") {
    const before = expenseSummary(item.before);
    const after = expenseSummary(item.after);
    if (before && after && before !== after)
      return `До: ${before}. После: ${after}.`;
    return after ?? before;
  }
  if (
    item.source === "settlement" &&
    item.after &&
    typeof item.after === "object"
  ) {
    if (Array.isArray(item.after.transfers))
      return item.after.transfers.length
        ? `Сохранено переводов: ${item.after.transfers.length}.`
        : "Переводы не потребовались.";
    if (item.after.reason === "all_transfers_confirmed")
      return "Все переводы подтверждены.";
    if (item.after.reason === "no_transfers") return "Все балансы равны нулю.";
  }
  return null;
}

export function EventHistory({
  token,
  eventId,
  revision,
}: {
  token: string;
  eventId: string;
  revision: number;
}) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<HistoryPage["nextCursor"]>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh" | "more") => {
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      if (mode === "initial") setInitialLoading(true);
      if (mode === "refresh") setBackgroundLoading(true);
      if (mode === "more") setLoadingMore(true);
      setError("");
      try {
        const page = await eventRequest<HistoryPage>(
          token,
          "history.list",
          {
            eventId,
            limit: 20,
            ...(mode === "more" && cursor ? { cursor } : {}),
          },
          { signal: next.signal },
        );
        setItems((current) =>
          mode === "more"
            ? [
                ...current,
                ...page.items.filter(
                  (item) =>
                    !current.some(
                      (old) => old.id === item.id && old.source === item.source,
                    ),
                ),
              ]
            : page.items,
        );
        setCursor(page.nextCursor);
      } catch (reason) {
        if ((reason as RequestFailure)?.kind !== "cancelled")
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить историю.",
          );
      } finally {
        if (!next.signal.aborted) {
          setInitialLoading(false);
          setBackgroundLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [cursor, eventId, token],
  );

  useEffect(() => {
    void load(items.length ? "refresh" : "initial");
    return () => controller.current?.abort();
    // Refresh is driven by the parent event revision; retaining items prevents flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, revision, token]);

  return (
    <section className="panel history-panel">
      <div className="page-heading">
        <h2>История мероприятия</h2>
        <button
          className="small-button"
          disabled={initialLoading || backgroundLoading || loadingMore}
          onClick={() => void load("refresh")}
        >
          {backgroundLoading ? "Обновляем…" : "Обновить историю"}
        </button>
      </div>
      {initialLoading && !items.length && (
        <p role="status">Загружаем историю…</p>
      )}
      {error && (
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button
            className="secondary"
            onClick={() => void load(items.length ? "refresh" : "initial")}
          >
            Повторить загрузку
          </button>
        </div>
      )}
      {!initialLoading && !items.length && !error && (
        <div className="empty-state compact-empty">
          <h3>История пока пуста</h3>
          <p>Здесь появятся расходы, расчёты и отметки переводов.</p>
        </div>
      )}
      <ol className="history-list">
        {items.map((item) => (
          <li key={`${item.source}:${item.id}`}>
            <strong>{actionNames[item.action] ?? "Изменение"}</strong>
            <span>{item.actorName}</span>
            <time dateTime={item.occurredAt}>
              {new Date(item.occurredAt).toLocaleString("ru-RU")}
            </time>
            {summary(item) && <p>{summary(item)}</p>}
            {item.source === "transfer" && item.before !== item.after && (
              <small>
                Статус: {String(item.before ?? "—")} →{" "}
                {String(item.after ?? "—")}
              </small>
            )}
          </li>
        ))}
      </ol>
      {cursor && (
        <button
          className="secondary"
          disabled={loadingMore}
          onClick={() => void load("more")}
        >
          {loadingMore ? "Загружаем…" : "Показать более ранние записи"}
        </button>
      )}
    </section>
  );
}
