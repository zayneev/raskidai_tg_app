import { useEffect, useRef, useState } from "react";
import { eventRequest, type EventDetails } from "./events-api";
import { formatMoney, formatSignedMoney } from "./money";
import {
  clearLocalState,
  isRecord,
  loadLocalState,
  saveLocalState,
} from "./local-state";
import { RequestFailure, shouldKeepPendingMutation } from "./resilience";

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
  sentAt: string | null;
  confirmedAt: string | null;
  notReceivedAt: string | null;
};
type Settlement = {
  id: string;
  eventId: string;
  sourceEventVersion: number;
  active: boolean;
  createdAt: string;
  cancelledAt: string | null;
  transfersStartedAt: string | null;
  balances: Balance[];
  transfers: Transfer[];
};
type Pending = {
  action:
    | "settlements.settle"
    | "settlements.cancel"
    | "transfers.send"
    | "transfers.confirm"
    | "transfers.not_received";
  data: {
    eventId: string;
    eventVersion: number;
    requestId: string;
    transferId?: string;
  };
};
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validPending = (value: unknown): value is Pending =>
  isRecord(value) &&
  [
    "settlements.settle",
    "settlements.cancel",
    "transfers.send",
    "transfers.confirm",
    "transfers.not_received",
  ].includes(String(value.action)) &&
  isRecord(value.data) &&
  typeof value.data.eventId === "string" &&
  typeof value.data.requestId === "string" &&
  uuid.test(value.data.requestId) &&
  Number.isInteger(value.data.eventVersion);

const statusNames: Record<Transfer["status"], string> = {
  pending: "Ожидает отправки",
  sent: "Отмечен отправленным",
  confirmed: "Получение подтверждено",
  not_received: "Не получен",
};

function formatTime(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

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
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<{
    kind: "settle" | "cancel" | "send" | "confirm" | "not_received";
    transfer?: Transfer;
  } | null>(null);
  // Keep the exact request ID and body until an ambiguous network result is resolved.
  const [pending, setPending] = useState<Pending | null>(() =>
    loadLocalState(
      userId,
      event.id,
      "settlement-mutation",
      "pending",
      validPending,
    ),
  );
  const inFlight = useRef(false);
  const hasAvailableTransferAction = settlement?.transfers.some(
    (transfer) =>
      (transfer.senderId === userId &&
        ["pending", "not_received"].includes(transfer.status)) ||
      (transfer.receiverId === userId && transfer.status === "sent"),
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (!settlement) setLoading(true);
    else setRefreshing(true);
    setError("");
    eventRequest<{ settlement: Settlement | null }>(
      token,
      "settlements.get",
      {
        eventId: event.id,
      },
      { signal: controller.signal },
    )
      .then((result) => {
        if (active) setSettlement(result.settlement);
      })
      .catch((reason) => {
        if (active && (reason as RequestFailure)?.kind !== "cancelled")
          setError(
            reason instanceof Error ? reason.message : "Ошибка загрузки.",
          );
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
    // Keep the prior settlement visible during a background refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, event.id, event.version]);

  const submit = async (request: Pending) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPending(request);
    saveLocalState(userId, event.id, "settlement-mutation", "pending", request);
    try {
      const result = await eventRequest<{
        settlement?: Settlement;
      }>(token, request.action, request.data);
      setPending(null);
      clearLocalState(userId, event.id, "settlement-mutation", "pending");
      setConfirm(null);
      if (request.action === "settlements.settle") {
        setSettlement(result.settlement ?? null);
        setNotice(
          result.settlement?.transfers.length === 0
            ? "Расчёт зафиксирован. Мероприятие завершено без переводов."
            : "Расчёт зафиксирован. Расходы и состав участников заблокированы.",
        );
      } else if (request.action === "settlements.cancel") {
        setSettlement(null);
        setNotice("Расчёт отменён. Расходы и приглашения снова доступны.");
      } else {
        setNotice(
          request.action === "transfers.send"
            ? "Отметка отправки сохранена. Приложение не проверяет банковский платёж."
            : request.action === "transfers.confirm"
              ? "Получение подтверждено."
              : "Отмечено, что перевод не получен. Отправителю нужно повторить отправку.",
        );
      }
      onChanged();
    } catch (reason) {
      if (!shouldKeepPendingMutation(reason)) {
        setPending(null);
        clearLocalState(userId, event.id, "settlement-mutation", "pending");
      }
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

  const begin = (
    kind: "settle" | "cancel" | "send" | "confirm" | "not_received",
    transfer?: Transfer,
  ) => {
    setError("");
    setNotice("");
    setConfirm({ kind, transfer });
  };
  const confirmed = () => {
    if (!confirm) return;
    const transferActions = {
      send: "transfers.send",
      confirm: "transfers.confirm",
      not_received: "transfers.not_received",
    } as const;
    void submit({
      action:
        confirm.kind === "settle"
          ? "settlements.settle"
          : confirm.kind === "cancel"
            ? "settlements.cancel"
            : transferActions[confirm.kind],
      data: {
        eventId: event.id,
        eventVersion: event.version,
        requestId: crypto.randomUUID(),
        ...(confirm.transfer ? { transferId: confirm.transfer.id } : {}),
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
          {refreshing ? "Обновляем…" : "Обновить расчёт"}
        </button>
      </div>
      {loading && <p role="status">Загружаем расчёт…</p>}
      {error && (
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button className="secondary" disabled={busy} onClick={onChanged}>
            Повторить загрузку
          </button>
        </div>
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
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              clearLocalState(
                userId,
                event.id,
                "settlement-mutation",
                "pending",
              );
              setPending(null);
            }}
          >
            Не повторять
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
          <p className="payment-disclaimer">
            Приложение только сохраняет ваши отметки — оно не проводит и не
            проверяет банковские платежи.
          </p>
          {settlement.transfers.length ? (
            <ol className="transfer-list">
              {settlement.transfers.map((transfer) => {
                const canSend =
                  event.status === "settled" &&
                  transfer.senderId === userId &&
                  ["pending", "not_received"].includes(transfer.status);
                const canReceive =
                  event.status === "settled" &&
                  transfer.receiverId === userId &&
                  transfer.status === "sent";
                return (
                  <li
                    key={transfer.id}
                    className={`transfer-${transfer.status}`}
                  >
                    <div className="transfer-summary">
                      <span>
                        {transfer.senderName} → {transfer.receiverName}
                      </span>
                      <strong>{formatMoney(transfer.amountKopecks)}</strong>
                    </div>
                    <span className="transfer-status">
                      {statusNames[transfer.status]}
                    </span>
                    <small>
                      {transfer.sentAt &&
                        `Отправлено: ${formatTime(transfer.sentAt)}`}
                      {transfer.notReceivedAt &&
                        ` · Не получено: ${formatTime(transfer.notReceivedAt)}`}
                      {transfer.confirmedAt &&
                        ` · Подтверждено: ${formatTime(transfer.confirmedAt)}`}
                    </small>
                    {transfer.status === "not_received" &&
                      transfer.senderId === userId && (
                        <p className="transfer-warning">
                          Получатель сообщил, что перевод не пришёл. Проверьте
                          реквизиты и отправьте деньги снова вне приложения.
                        </p>
                      )}
                    {(canSend || canReceive) && (
                      <div className="actions transfer-actions">
                        {canSend && (
                          <button
                            disabled={busy || pending !== null}
                            onClick={() => begin("send", transfer)}
                          >
                            Отметить отправленным
                          </button>
                        )}
                        {canReceive && (
                          <>
                            <button
                              disabled={busy || pending !== null}
                              onClick={() => begin("confirm", transfer)}
                            >
                              Получил
                            </button>
                            <button
                              className="secondary"
                              disabled={busy || pending !== null}
                              onClick={() => begin("not_received", transfer)}
                            >
                              Не получил
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="zero-result">
              Все балансы равны нулю — мероприятие завершено без переводов.
            </p>
          )}
          {event.status === "completed" && settlement.transfers.length > 0 && (
            <p className="zero-result">
              Все переводы подтверждены. Мероприятие завершено.
            </p>
          )}
          {event.creatorId === userId &&
            event.status === "settled" &&
            !settlement.transfersStartedAt && (
              <button
                className="secondary"
                disabled={busy || pending !== null}
                onClick={() => begin("cancel")}
              >
                Вернуться к редактированию
              </button>
            )}
          {event.status === "settled" &&
            !hasAvailableTransferAction &&
            !(event.creatorId === userId && !settlement.transfersStartedAt) && (
              <p className="muted">
                Сейчас у вас нет доступных действий. Обновите карточку после
                действий других участников.
              </p>
            )}
        </>
      )}

      {confirm && (
        <div className="confirmation" role="alert">
          <h3>
            {confirm.kind === "settle"
              ? "Зафиксировать расчёт?"
              : confirm.kind === "cancel"
                ? "Вернуться к редактированию?"
                : confirm.kind === "send"
                  ? "Отметить перевод отправленным?"
                  : confirm.kind === "confirm"
                    ? "Подтвердить получение?"
                    : "Сообщить, что перевод не получен?"}
          </h3>
          <p>
            {confirm.kind === "settle"
              ? "Будет сохранён неизменяемый снимок расходов и долей. Новые расходы, приглашения, вход и выход участников будут заблокированы."
              : confirm.kind === "cancel"
                ? "Текущий расчёт и переводы останутся в истории, но станут неактивными. Расходы и приглашения снова можно будет менять."
                : confirm.kind === "send"
                  ? "Подтвердите только после реальной отправки денег в банковском приложении. Раскидай не проводит и не проверяет платёж."
                  : confirm.kind === "confirm"
                    ? "Подтвердите, что деньги действительно поступили. После подтверждения перевод изменить нельзя."
                    : "Отправитель увидит, что деньги не пришли, и сможет повторно отметить перевод отправленным после новой попытки."}
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
