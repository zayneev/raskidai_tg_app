import { useEffect, useRef, useState } from "react";
import { EventApiError, eventRequest, type EventDetails } from "./events-api";
import { formatMoney, formatSignedMoney } from "./money";

type Balance = {
  userId: string;
  displayName: string;
  paidKopecks: number;
  shareKopecks: number;
  balanceKopecks: number;
};
type Transfer = {
  id: string;
  sequence: number;
  senderId: string;
  senderName: string;
  receiverId: string;
  receiverName: string;
  amountKopecks: number;
  status: "pending" | "sent" | "confirmed" | "not_received";
  active: boolean;
};
type Settlement = {
  id: string;
  eventId: string;
  sourceEventVersion: number;
  active: boolean;
  createdAt: string;
  cancelledAt: string | null;
  balances: Balance[];
  transfers: Transfer[];
};
type Pending = {
  action: "settlements.settle" | "settlements.cancel";
  data: { eventId: string; eventVersion: number; requestId: string };
};

export function Settlements({
  token,
  userId,
  event,
  onChanged,
}: {
  token: string;
  userId: string;
  event: EventDetails;
  onChanged: () => void;
}) {
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<"settle" | "cancel" | null>(null);
  // Keep the exact request ID and body until an ambiguous network result is resolved.
  const [pending, setPending] = useState<Pending | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    eventRequest<{ settlement: Settlement | null }>(token, "settlements.get", {
      eventId: event.id,
    })
      .then((result) => {
        if (active) setSettlement(result.settlement);
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "Ошибка загрузки.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, event.id, event.version]);

  const submit = async (request: Pending) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPending(request);
    try {
      const result = await eventRequest<{
        settlement?: Settlement;
      }>(token, request.action, request.data);
      setPending(null);
      setConfirm(null);
      if (request.action === "settlements.settle") {
        setSettlement(result.settlement ?? null);
        setNotice(
          "Расчёт зафиксирован. Расходы и состав участников заблокированы.",
        );
      } else {
        setSettlement(null);
        setNotice("Расчёт отменён. Расходы и приглашения снова доступны.");
      }
      onChanged();
    } catch (reason) {
      if (reason instanceof EventApiError) setPending(null);
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось выполнить действие.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const begin = (action: "settle" | "cancel") => {
    setError("");
    setNotice("");
    setConfirm(action);
  };
  const confirmed = () => {
    if (!confirm) return;
    void submit({
      action:
        confirm === "settle" ? "settlements.settle" : "settlements.cancel",
      data: {
        eventId: event.id,
        eventVersion: event.version,
        requestId: crypto.randomUUID(),
      },
    });
  };

  return (
    <section className="panel settlements-panel">
      <div className="page-heading">
        <h2>Расчёт</h2>
        <button
          className="small-button"
          disabled={loading || busy}
          onClick={() => onChanged()}
        >
          Обновить расчёт
        </button>
      </div>
      {loading && <p role="status">Загружаем расчёт…</p>}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div className="confirmation">
          <p>
            Ответ сервера неизвестен. Сохранены исходные данные и requestId —
            повтор безопасен.
          </p>
          <button disabled={busy} onClick={() => void submit(pending)}>
            Повторить тот же запрос
          </button>
        </div>
      )}

      {!loading && event.status === "draft" && !settlement && (
        <>
          <p>
            После фиксации расходы, приглашение и состав участников нельзя будет
            менять до разрешённого возврата к редактированию.
          </p>
          {event.creatorId === userId ? (
            <button
              disabled={busy || pending !== null}
              onClick={() => begin("settle")}
            >
              Раскидать
            </button>
          ) : (
            <p className="muted">
              Зафиксировать расчёт может только создатель.
            </p>
          )}
        </>
      )}

      {settlement && (
        <>
          <h3>Балансы</h3>
          <ul className="balance-list">
            {settlement.balances.map((balance) => (
              <li key={balance.userId}>
                <span>{balance.displayName}</span>
                <strong
                  className={
                    balance.balanceKopecks > 0
                      ? "positive"
                      : balance.balanceKopecks < 0
                        ? "negative"
                        : ""
                  }
                >
                  {formatSignedMoney(balance.balanceKopecks)}
                </strong>
                <small>
                  оплачено {formatMoney(balance.paidKopecks)} · доля{" "}
                  {formatMoney(balance.shareKopecks)}
                </small>
              </li>
            ))}
          </ul>
          <h3>Переводы</h3>
          {settlement.transfers.length ? (
            <ol className="transfer-list">
              {settlement.transfers.map((transfer) => (
                <li key={transfer.id}>
                  <span>
                    {transfer.senderName} → {transfer.receiverName}
                  </span>
                  <strong>{formatMoney(transfer.amountKopecks)}</strong>
                </li>
              ))}
            </ol>
          ) : (
            <p className="zero-result">
              Все балансы равны нулю — переводить ничего не нужно.
            </p>
          )}
          {event.creatorId === userId && event.status === "settled" && (
            <button
              className="secondary"
              disabled={busy || pending !== null}
              onClick={() => begin("cancel")}
            >
              Вернуться к редактированию
            </button>
          )}
        </>
      )}

      {confirm && (
        <div className="confirmation" role="alert">
          <h3>
            {confirm === "settle"
              ? "Зафиксировать расчёт?"
              : "Вернуться к редактированию?"}
          </h3>
          <p>
            {confirm === "settle"
              ? "Будет сохранён неизменяемый снимок расходов и долей. Новые расходы, приглашения, вход и выход участников будут заблокированы."
              : "Текущий расчёт и переводы останутся в истории, но станут неактивными. Расходы и приглашения снова можно будет менять."}
          </p>
          <div className="actions">
            <button disabled={busy} onClick={confirmed}>
              Подтвердить
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
