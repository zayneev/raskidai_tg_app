import { useEffect, useRef, useState } from "react";
import { eventRequest, EventApiError, type EventDetails } from "./events-api";
import { formatMoney, parseRubles, rublesInput } from "./money";

type Expense = {
  id: string;
  author_id: string;
  author_name: string;
  title: string;
  amount_kopecks: number;
  version: number;
  shares: { user_id: string; display_name: string; amount_kopecks: number }[];
};
type Audit = {
  id: string;
  actor_name: string;
  action: "create" | "update" | "delete";
  created_at: string;
  before_data: Expense | null;
  after_data: Expense | null;
};
type Pending = { action: string; data: Record<string, unknown> };
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
  const [history, setHistory] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<Expense | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  // A failed/ambiguous request is retried with the exact payload and UUID.
  const [pending, setPending] = useState<Pending | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      eventRequest<{ expenses: Expense[] }>(token, "expenses.list", {
        eventId: event.id,
      }),
      eventRequest<{ history: Audit[] }>(token, "expenses.history", {
        eventId: event.id,
      }),
    ])
      .then(([a, b]) => {
        if (active) {
          setExpenses(a.expenses);
          setHistory(b.history);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, event.id, revision]);
  const open = (expense: Expense | "new") => {
    setForm(expense);
    setError("");
    setNotice("");
    setTitle(expense === "new" ? "" : expense.title);
    setAmount(expense === "new" ? "" : rublesInput(expense.amount_kopecks));
    setSelected(
      expense === "new"
        ? event.members.map((m) => m.id)
        : expense.shares.map((s) => s.user_id),
    );
  };
  const submit = async (request: Pending) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setPending(request);
    try {
      await eventRequest(token, request.action, request.data);
      setPending(null);
      setForm(null);
      setDeleting(null);
      setNotice("Сохранено.");
      setRevision((v) => v + 1);
    } catch (e) {
      if (e instanceof EventApiError && e.status >= 400 && e.status < 500)
        setPending(null);
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
          Обновить расходы
        </button>
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
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
              onChange={(e) => setTitle(e.target.value)}
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
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <fieldset disabled={disabled}>
            <legend>Разделить поровну между</legend>
            {event.members.map((m) => (
              <label className="share-choice" key={m.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, m.id]
                        : ids.filter((id) => id !== m.id),
                    )
                  }
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
              onClick={() => setForm(null)}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
      {!loading && !expenses.length && <p>Расходов пока нет.</p>}
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
      <details>
        <summary>История изменений ({history.length})</summary>
        {!history.length && <p>История пока пуста.</p>}
        {history.map((item) => (
          <article key={item.id} className="expense-item">
            <p>
              <strong>{item.actor_name}</strong> ·{" "}
              {
                { create: "Создание", update: "Изменение", delete: "Удаление" }[
                  item.action
                ]
              }{" "}
              · {new Date(item.created_at).toLocaleString("ru-RU")}
            </p>
            {item.before_data && (
              <>
                <p>До:</p>
                <Snapshot expense={item.before_data} />
              </>
            )}
            {item.after_data && (
              <>
                <p>После:</p>
                <Snapshot expense={item.after_data} />
              </>
            )}
          </article>
        ))}
      </details>
    </section>
  );
}
