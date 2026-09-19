import { useEffect, useRef, useState } from "react";
import * as m from "motion/react-m";
import { eventRequest, type EventDetails } from "./events-api";
import { formatDisplayMoney, formatMoney, formatSignedMoney } from "./money";
import {
  clearLocalState,
  isRecord,
  loadLocalState,
  saveLocalState,
} from "./local-state";
import { RequestFailure, shouldKeepPendingMutation } from "./resilience";
import { BottomSheet } from "./ui";
import type {
  ProposedTransfer,
  SettlementPreview,
  SettlementRecord,
  TransferRecord,
} from "./visual";

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

const statusNames: Record<TransferRecord["status"], string> = {
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
  const [settlement, setSettlement] = useState<SettlementRecord | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [confirm, setConfirm] = useState<{
    kind: "settle" | "cancel" | "send" | "confirm" | "not_received";
    transfer?: TransferRecord;
  } | null>(null);
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

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (!settlement && !preview) setLoading(true);
    else setRefreshing(true);
    setError("");
    const action =
      event.status === "draft" ? "settlements.preview" : "settlements.get";
    eventRequest<{
      preview?: SettlementPreview;
      settlement?: SettlementRecord | null;
    }>(token, action, { eventId: event.id }, { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        if (action === "settlements.preview") {
          setPreview(result.preview ?? null);
          setSettlement(null);
        } else {
          setSettlement(result.settlement ?? null);
          setPreview(null);
        }
      })
      .catch((reason) => {
        if (active && (reason as RequestFailure)?.kind !== "cancelled")
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить расчёт.",
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
    // Keep prior calculation visible during refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, event.id, event.status, event.version, revision]);

  const submit = async (request: Pending) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPending(request);
    saveLocalState(userId, event.id, "settlement-mutation", "pending", request);
    try {
      const result = await eventRequest<{ settlement?: SettlementRecord }>(
        token,
        request.action,
        request.data,
      );
      clearLocalState(userId, event.id, "settlement-mutation", "pending");
      setPending(null);
      setConfirm(null);
      if (request.action === "settlements.settle") {
        setSettlement(result.settlement ?? null);
        setPreview(null);
        setNotice(
          result.settlement?.transfers.length
            ? "Расчёт зафиксирован. Расходы заблокированы."
            : "Расчёт завершён без переводов.",
        );
      } else if (request.action === "settlements.cancel") {
        setSettlement(null);
        setNotice("Расчёт отменён. Расходы снова доступны.");
      } else {
        setNotice(
          request.action === "transfers.send"
            ? "Отправка отмечена."
            : request.action === "transfers.confirm"
              ? "Получение подтверждено."
              : "Отмечено, что перевод не получен.",
        );
      }
      setRevision((value) => value + 1);
      onChanged();
    } catch (reason) {
      if (!shouldKeepPendingMutation(reason)) {
        clearLocalState(userId, event.id, "settlement-mutation", "pending");
        setPending(null);
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
    transfer?: TransferRecord,
  ) => setConfirm({ kind, transfer });
  const confirmed = () => {
    if (!confirm) return;
    const actions = {
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
            : actions[confirm.kind],
      data: {
        eventId: event.id,
        eventVersion: event.version,
        requestId: crypto.randomUUID(),
        ...(confirm.transfer ? { transferId: confirm.transfer.id } : {}),
      },
    });
  };

  const balances = settlement?.balances ?? preview?.balances ?? [];
  const personalBalance = balances.find((balance) => balance.userId === userId);
  const proposed = preview?.transfers ?? [];
  const openTransfers =
    settlement?.transfers.filter(
      (transfer) => transfer.status !== "confirmed",
    ) ?? [];
  const outgoing = openTransfers.filter(
    (transfer) => transfer.senderId === userId,
  );
  const incoming = openTransfers.filter(
    (transfer) => transfer.receiverId === userId,
  );
  const between = openTransfers.filter(
    (transfer) =>
      transfer.senderId !== userId && transfer.receiverId !== userId,
  );
  const completed =
    settlement?.transfers.filter(
      (transfer) => transfer.status === "confirmed",
    ) ?? [];

  const renderProposed = (transfer: ProposedTransfer) => (
    <li
      className="transfer-card proposed-transfer"
      key={`${transfer.sequence}:${transfer.senderId}:${transfer.receiverId}`}
    >
      <div className="transfer-summary">
        <span>
          {transfer.senderName} → {transfer.receiverName}
        </span>
        <strong>{formatDisplayMoney(transfer.amountKopecks)}</strong>
      </div>
      <small>После фиксации расчёта</small>
    </li>
  );
  const renderTransfer = (transfer: TransferRecord) => {
    const canSend =
      event.status === "settled" &&
      transfer.senderId === userId &&
      ["pending", "not_received"].includes(transfer.status);
    const canReceive =
      event.status === "settled" &&
      transfer.receiverId === userId &&
      transfer.status === "sent";
    return (
      <m.li
        className="transfer-card"
        key={transfer.id}
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="transfer-summary">
          <span>
            {transfer.senderName} → {transfer.receiverName}
          </span>
          <strong>{formatDisplayMoney(transfer.amountKopecks)}</strong>
        </div>
        <small>
          {statusNames[transfer.status]}
          {transfer.confirmedAt ? ` · ${formatTime(transfer.confirmedAt)}` : ""}
        </small>
        {transfer.status === "not_received" && transfer.senderId === userId && (
          <p className="transfer-warning">
            Получатель сообщил, что деньги не пришли. Проверьте перевод перед
            повторной отметкой.
          </p>
        )}
        {(canSend || canReceive) && (
          <div className="actions transfer-actions">
            {canSend && (
              <button
                disabled={busy || pending !== null}
                onClick={() => begin("send", transfer)}
              >
                Я перевёл
              </button>
            )}
            {canReceive && (
              <>
                <button
                  disabled={busy || pending !== null}
                  onClick={() => begin("confirm", transfer)}
                >
                  Получено
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
      </m.li>
    );
  };

  return (
    <section className="settlements-panel">
      <div className="calculation-heading">
        <div>
          <span className="eyebrow">
            {event.status === "draft"
              ? "Предварительный расчёт"
              : event.status === "completed"
                ? "Расчёты завершены"
                : "Расчёт зафиксирован"}
          </span>
          <h2>Ваш результат</h2>
        </div>
        <button
          className="icon-refresh"
          disabled={loading || busy}
          onClick={() => setRevision((value) => value + 1)}
          aria-label="Обновить расчёт"
        >
          {refreshing ? "…" : "↻"}
        </button>
      </div>
      {loading && !balances.length && <p role="status">Считаем результат…</p>}
      {error && (
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button
            className="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            Повторить
          </button>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {pending && !busy && (
        <div className="confirmation">
          <p>Ответ сервера неизвестен. Повтор использует тот же requestId.</p>
          <div className="actions">
            <button onClick={() => void submit(pending)}>Повторить</button>
            <button
              className="secondary"
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
        </div>
      )}

      {personalBalance && (
        <m.div className="personal-balance" layout>
          <span>
            {personalBalance.balanceKopecks > 0
              ? "Вам вернут"
              : personalBalance.balanceKopecks < 0
                ? "Вы должны"
                : "Баланс"}
          </span>
          <strong>
            {formatDisplayMoney(Math.abs(personalBalance.balanceKopecks))}
          </strong>
          <small>
            Вы оплатили {formatMoney(personalBalance.paidKopecks)} · ваша доля{" "}
            {formatMoney(personalBalance.shareKopecks)}
          </small>
        </m.div>
      )}

      {balances.length > 0 && (
        <details className="balance-details">
          <summary>Балансы участников</summary>
          <ul className="balance-list">
            {balances.map((balance) => (
              <li key={balance.userId}>
                <span>{balance.displayName}</span>
                <strong>{formatSignedMoney(balance.balanceKopecks)}</strong>
                <small>
                  оплачено {formatMoney(balance.paidKopecks)} · доля{" "}
                  {formatMoney(balance.shareKopecks)}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}

      {event.status === "draft" && preview && (
        <>
          <div className="calculation-note">
            <strong>Расчёт меняется вместе с расходами</strong>
            <p>Переводы станут задачами участников после фиксации.</p>
          </div>
          {proposed.length ? (
            <div className="transfer-group">
              <h3>Предполагаемые переводы</h3>
              <ol className="transfer-list">{proposed.map(renderProposed)}</ol>
            </div>
          ) : (
            <p className="zero-result">
              Все балансы равны нулю — переводы не потребуются.
            </p>
          )}
          {event.creatorId !== userId && (
            <p className="muted">
              Зафиксировать расчёт может создатель мероприятия.
            </p>
          )}
        </>
      )}

      {settlement && (
        <>
          <p className="payment-disclaimer">
            Приложение сохраняет отметки, но не проводит и не проверяет
            банковские платежи.
          </p>
          {outgoing.length > 0 && (
            <div className="transfer-group">
              <h3>Вам нужно перевести</h3>
              <ol className="transfer-list">{outgoing.map(renderTransfer)}</ol>
            </div>
          )}
          {incoming.length > 0 && (
            <div className="transfer-group">
              <h3>Вам переведут</h3>
              <ol className="transfer-list">{incoming.map(renderTransfer)}</ol>
            </div>
          )}
          {between.length > 0 && (
            <details className="completed-group">
              <summary>Между участниками · {between.length}</summary>
              <ol className="transfer-list">{between.map(renderTransfer)}</ol>
            </details>
          )}
          {completed.length > 0 && (
            <details className="completed-group">
              <summary>Завершённые · {completed.length}</summary>
              <ol className="transfer-list">{completed.map(renderTransfer)}</ol>
            </details>
          )}
          {settlement.transfers.length === 0 && (
            <p className="zero-result">Мероприятие завершено без переводов.</p>
          )}
          {event.status === "completed" && settlement.transfers.length > 0 && (
            <p className="zero-result">Все переводы подтверждены.</p>
          )}
          {event.creatorId === userId &&
            event.status === "settled" &&
            !settlement.transfersStartedAt && (
              <button
                className="secondary standalone-action"
                disabled={busy || pending !== null}
                onClick={() => begin("cancel")}
              >
                Вернуться к редактированию
              </button>
            )}
        </>
      )}

      {event.status === "draft" && event.creatorId === userId && preview && (
        <div className="floating-action">
          <m.button
            className="primary-action"
            disabled={busy || pending !== null}
            onClick={() => begin("settle")}
            whileTap={{ scale: 0.98 }}
          >
            Зафиксировать расчёт
          </m.button>
        </div>
      )}

      <BottomSheet
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Подтверждение"
        className="confirmation-sheet"
      >
        {confirm && (
          <>
            <h2>
              {confirm.kind === "settle"
                ? "Зафиксировать расчёт?"
                : confirm.kind === "cancel"
                  ? "Вернуться к редактированию?"
                  : confirm.kind === "send"
                    ? "Отметить перевод отправленным?"
                    : confirm.kind === "confirm"
                      ? "Подтвердить получение?"
                      : "Сообщить, что перевод не получен?"}
            </h2>
            <p>
              {confirm.kind === "settle"
                ? "Расходы, приглашение и состав участников будут заблокированы."
                : confirm.kind === "cancel"
                  ? "Расходы снова можно будет изменять."
                  : confirm.kind === "send"
                    ? "Подтвердите действие после реальной отправки денег."
                    : confirm.kind === "confirm"
                      ? "После подтверждения перевод изменить нельзя."
                      : "Отправитель увидит, что деньги не пришли."}
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
          </>
        )}
      </BottomSheet>
    </section>
  );
}
