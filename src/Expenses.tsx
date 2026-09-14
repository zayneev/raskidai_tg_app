import { useEffect, useRef, useState } from "react";
import { eventRequest, type EventDetails } from "./events-api";
import { formatMoney, parseRubles, rublesInput } from "./money";
import {
  clearLocalState,
  isRecord,
  loadLocalState,
  saveLocalState,
} from "./local-state";
import { RequestFailure, shouldKeepPendingMutation } from "./resilience";

type Expense = {
  id: string;
  author_id: string;
  author_name: string;
  title: string;
  amount_kopecks: number;
  version: number;
  shares: { user_id: string; display_name: string; amount_kopecks: number }[];
};
type Pending = { action: string; data: Record<string, unknown> };
type ExpenseDraft = {
  mode: "new" | "edit";
  expense: Expense | null;
  title: string;
  amount: string;
  selected: string[];
  eventVersion: number;
};
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validPending = (value: unknown): value is Pending =>
  isRecord(value) &&
  ["expenses.create", "expenses.update", "expenses.delete"].includes(
    String(value.action),
  ) &&
  isRecord(value.data) &&
  typeof value.data.requestId === "string" &&
  uuid.test(value.data.requestId) &&
  typeof value.data.eventId === "string";
const validExpense = (value: unknown): value is Expense =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.author_id === "string" &&
  typeof value.author_name === "string" &&
  typeof value.title === "string" &&
  Number.isSafeInteger(value.amount_kopecks) &&
  Number.isInteger(value.version) &&
  Array.isArray(value.shares);
const validDraft = (value: unknown): value is ExpenseDraft =>
  isRecord(value) &&
  (value.mode === "new" || value.mode === "edit") &&
  typeof value.title === "string" &&
  value.title.length <= 120 &&
  typeof value.amount === "string" &&
  Array.isArray(value.selected) &&
  value.selected.every((id) => typeof id === "string") &&
  Number.isInteger(value.eventVersion) &&
  ((value.mode === "new" && value.expense === null) ||
    (value.mode === "edit" && validExpense(value.expense)));
function Snapshot({ expense }: { expense: Expense }) {
  return (
    <div>
      <strong>
        {expense.title} · {formatMoney(expense.amount_kopecks)}
      </strong>
      <p>Оплатил(а): {expense.author_name}</p>
      <ul>
        {expense.shares.map((s) => (
          <li key={s.user_id}>
            {s.display_name} — {formatMoney(s.amount_kopecks)}
          </li>
        ))}
      </ul>
    </div>
  );
}
export function Expenses({
  token,
  userId,
  event,
}: {
  token: string;
  userId: string;
  event: EventDetails;
}) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const restored = useRef(
    loadLocalState(userId, event.id, "expense-form", "draft", validDraft),
  );
  const restoredExpense = restored.current?.expense as Expense | null;
  const [form, setForm] = useState<Expense | "new" | null>(
    restored.current
      ? restored.current.mode === "new"
        ? "new"
        : restoredExpense
      : null,
  );
  const [title, setTitle] = useState(restored.current?.title ?? "");
  const [amount, setAmount] = useState(restored.current?.amount ?? "");
  const [selected, setSelected] = useState<string[]>(
    (restored.current?.selected ?? []).filter((id) =>
      event.members.some((member) => member.id === id),
    ),
  );
  const [deleting, setDeleting] = useState<Expense | null>(null);
  // A failed/ambiguous request is retried with the exact payload and UUID.
  const [pending, setPending] = useState<Pending | null>(() =>
    loadLocalState(
      userId,
      event.id,
      "expense-mutation",
      "pending",
      validPending,
    ),
  );
  const editingVersion = useRef(
    restored.current?.eventVersion ?? event.version,
  );
  const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (!expenses.length) setLoading(true);
    else setRefreshing(true);
    eventRequest<{ expenses: Expense[] }>(
      token,
      "expenses.list",
      {
        eventId: event.id,
      },
      { signal: controller.signal },
    )
      .then((result) => {
        if (active) {
          setExpenses(result.expenses);
        }
      })
      .catch((e) => {
        if (active && (e as RequestFailure)?.kind !== "cancelled")
          setError(
            e instanceof Error ? e.message : "Ошибка загрузки расходов.",
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
    // Keep existing data and the form while refreshing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, event.id, revision]);
  const persistDraft = (
    nextForm: Expense | "new",
    nextTitle: string,
    nextAmount: string,
    nextSelected: string[],
  ) => {
    if (pending) {
      clearLocalState(userId, event.id, "expense-mutation", "pending");
      setPending(null);
    }
    saveLocalState(userId, event.id, "expense-form", "draft", {
      mode: nextForm === "new" ? "new" : "edit",
      expense: nextForm === "new" ? null : nextForm,
      title: nextTitle,
      amount: nextAmount,
      selected: nextSelected,
      eventVersion: editingVersion.current,
    });
  };
  const open = (expense: Expense | "new") => {
    setForm(expense);
    setError("");
    setNotice("");
    setTitle(expense === "new" ? "" : expense.title);
    setAmount(expense === "new" ? "" : rublesInput(expense.amount_kopecks));
    const nextSelected =
      expense === "new"
        ? event.members.map((m) => m.id)
        : expense.shares.map((s) => s.user_id);
    setSelected(nextSelected);
    editingVersion.current = event.version;
    persistDraft(
      expense,
      expense === "new" ? "" : expense.title,
      expense === "new" ? "" : rublesInput(expense.amount_kopecks),
      nextSelected,
    );
  };
  const submit = async (request: Pending) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setPending(request);
    saveLocalState(userId, event.id, "expense-mutation", "pending", request);
    try {
      await eventRequest(token, request.action, request.data);
      setPending(null);
      clearLocalState(userId, event.id, "expense-mutation", "pending");
      clearLocalState(userId, event.id, "expense-form", "draft");
      setForm(null);
      setDeleting(null);
      setNotice("Сохранено.");
      setRevision((v) => v + 1);
    } catch (e) {
      if (!shouldKeepPendingMutation(e)) {
        setPending(null);
        clearLocalState(userId, event.id, "expense-mutation", "pending");
      }
      if (
        e instanceof RequestFailure &&
        (e.kind === "forbidden" ||
          e.kind === "not_found" ||
          e.code === "event_locked")
      ) {
        clearLocalState(userId, event.id, "expense-form", "draft");
        setForm(null);
      }
      setError(e instanceof Error ? e.message : "Не удалось сохранить.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const locked = event.status !== "draft";
  const disabled = busy || pending !== null;
  return (
    <section className="panel expenses-panel">
      <div className="page-heading">
        <h2>Расходы</h2>
        <button
          className="small-button"
          disabled={busy || loading}
          onClick={() => {
            setError("");
            setRevision((v) => v + 1);
          }}
        >
          {refreshing ? "Обновляем…" : "Обновить расходы"}
        </button>
      </div>
      {error && (
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button
            className="secondary"
            disabled={busy || refreshing}
            onClick={() => setRevision((value) => value + 1)}
          >
            Повторить загрузку
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div className="confirmation">
          <p>
            Запрос сохранён. Повторите отправку, чтобы узнать результат. Форма
            сохранена.
          </p>
          <button disabled={busy} onClick={() => void submit(pending)}>
            Повторить отправку
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              clearLocalState(userId, event.id, "expense-mutation", "pending");
              setPending(null);
            }}
          >
            Не повторять
          </button>
        </div>
      )}
      {loading && <p role="status">Загружаем расходы…</p>}
      {locked ? (
        <p>Расчёт зафиксирован. Изменение расходов недоступно.</p>
      ) : (
        <button
          disabled={disabled || form !== null || deleting !== null}
          onClick={() => open("new")}
        >
          + Добавить расход
        </button>
      )}
      {form && (
        <form
          className="event-form"
          onSubmit={(e) => {
            e.preventDefault();
            const kopecks = parseRubles(amount);
            if (kopecks === null || !selected.length) {
              setError(
                "Укажите сумму с точностью до копейки и хотя бы одного участника.",
              );
              return;
            }
            void submit({
              action: form === "new" ? "expenses.create" : "expenses.update",
              data: {
                eventId: event.id,
                requestId: crypto.randomUUID(),
                title,
                amountKopecks: kopecks,
                memberIds: [...selected].sort(),
                ...(form === "new"
                  ? {}
                  : { expenseId: form.id, version: form.version }),
              },
            });
          }}
        >
          <h3>{form === "new" ? "Новый расход" : "Редактирование расхода"}</h3>
          {event.version !== editingVersion.current && (
            <p className="warning-box" role="alert">
              Данные мероприятия изменились во время редактирования. Обновите
              расходы перед сохранением; старая версия не будет отправлена
              молча.
            </p>
          )}
          <p>
            Плательщик:{" "}
            {form === "new"
              ? event.members.find((m) => m.id === userId)?.displayName
              : form.author_name}
          </p>
          <label>
            Название
            <input
              required
              maxLength={120}
              value={title}
              disabled={disabled}
              onChange={(e) => {
                setTitle(e.target.value);
                persistDraft(form, e.target.value, amount, selected);
              }}
            />
          </label>
          <label>
            Сумма, ₽
            <input
              required
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              disabled={disabled}
              onChange={(e) => {
                setAmount(e.target.value);
                persistDraft(form, title, e.target.value, selected);
              }}
            />
          </label>
          <fieldset disabled={disabled}>
            <legend>Разделить поровну между</legend>
            {event.members.map((m) => (
              <label className="share-choice" key={m.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...selected, m.id]
                      : selected.filter((id) => id !== m.id);
                    setSelected(next);
                    persistDraft(form, title, amount, next);
                  }}
                />
                {m.displayName}
                {m.id === userId ? " (вы)" : ""}
              </label>
            ))}
          </fieldset>
          <p className="muted">
            Можно исключить себя. Остаток копеек распределяется по порядку ID
            участников.
          </p>
          <div className="actions">
            <button
              disabled={disabled || locked || !selected.length || !title.trim()}
              type="submit"
            >
              Сохранить
            </button>
            <button
              type="button"
              className="secondary"
              disabled={disabled}
              onClick={() => {
                clearLocalState(userId, event.id, "expense-form", "draft");
                clearLocalState(
                  userId,
                  event.id,
                  "expense-mutation",
                  "pending",
                );
                setPending(null);
                setForm(null);
              }}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
      {!loading && !expenses.length && !error && (
        <div className="empty-state compact-empty">
          <h3>Расходов пока нет</h3>
          <p>Добавьте первую покупку, чтобы начать общий расчёт.</p>
        </div>
      )}
      <div className="expense-list">
        {expenses.map((expense) => (
          <article key={expense.id} className="expense-item">
            <Snapshot expense={expense} />
            {!locked &&
              (expense.author_id === userId || event.creatorId === userId) && (
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={disabled || form !== null || deleting !== null}
                    onClick={() => open(expense)}
                  >
                    Изменить
                  </button>
                  <button
                    className="secondary danger"
                    disabled={disabled || form !== null || deleting !== null}
                    onClick={() => setDeleting(expense)}
                  >
                    Удалить
                  </button>
                </div>
              )}
          </article>
        ))}
      </div>
      {deleting && (
        <div className="confirmation" role="alert">
          <h3>Удалить «{deleting.title}»?</h3>
          <p>Запись об удалении останется в истории.</p>
          <div className="actions">
            <button
              disabled={disabled || locked}
              onClick={() =>
                void submit({
                  action: "expenses.delete",
                  data: {
                    eventId: event.id,
                    expenseId: deleting.id,
                    version: deleting.version,
                    requestId: crypto.randomUUID(),
                  },
                })
              }
            >
              Подтвердить удаление
            </button>
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => setDeleting(null)}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
