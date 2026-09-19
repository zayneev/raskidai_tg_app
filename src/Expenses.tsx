import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { eventRequest, type EventDetails } from "./events-api";
import {
  formatDisplayMoney,
  formatMoney,
  parseRubles,
  rublesInput,
} from "./money";
import {
  clearLocalState,
  isRecord,
  loadLocalState,
  saveLocalState,
} from "./local-state";
import { RequestFailure, shouldKeepPendingMutation } from "./resilience";
import { BottomSheet, ScreenHeader, pageTransition } from "./ui";
import type { ExpenseRecord } from "./visual";

type Expense = ExpenseRecord;
type Pending = {
  action: "expenses.create" | "expenses.update" | "expenses.delete";
  data: Record<string, unknown> & { requestId: string };
};
type ExpenseDraft = {
  mode: "new" | "edit";
  expenseId: string | null;
  expenseVersion: number | null;
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
  uuid.test(value.data.requestId);
const validDraft = (value: unknown): value is ExpenseDraft =>
  isRecord(value) &&
  ["new", "edit"].includes(String(value.mode)) &&
  ((value.mode === "new" &&
    value.expenseId === null &&
    value.expenseVersion === null) ||
    (value.mode === "edit" &&
      typeof value.expenseId === "string" &&
      Number.isInteger(value.expenseVersion))) &&
  typeof value.title === "string" &&
  value.title.length <= 120 &&
  typeof value.amount === "string" &&
  value.amount.length <= 20 &&
  Array.isArray(value.selected) &&
  value.selected.every((id) => typeof id === "string") &&
  Number.isInteger(value.eventVersion);

export function Expenses({
  token,
  userId,
  event,
  onlyMine,
  onOnlyMine,
  onChanged,
}: {
  token: string;
  userId: string;
  event: EventDetails;
  onlyMine: boolean;
  onOnlyMine: (value: boolean) => void;
  onChanged: () => void;
}) {
  const restoredDraft = useRef(
    loadLocalState(userId, event.id, "expense-form", "draft", validDraft),
  );
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<"new" | Expense | null>(
    restoredDraft.current?.mode === "new" ? "new" : null,
  );
  const [detail, setDetail] = useState<Expense | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [title, setTitle] = useState(restoredDraft.current?.title ?? "");
  const [amount, setAmount] = useState(restoredDraft.current?.amount ?? "");
  const [selected, setSelected] = useState<string[]>(
    restoredDraft.current?.selected ?? event.members.map((member) => member.id),
  );
  const editingVersion = useRef(
    restoredDraft.current?.eventVersion ?? event.version,
  );
  const editingExpenseVersion = useRef<number | null>(
    restoredDraft.current?.expenseVersion ?? null,
  );
  const [pending, setPending] = useState<Pending | null>(() =>
    loadLocalState(
      userId,
      event.id,
      "expense-mutation",
      "pending",
      validPending,
    ),
  );
  const [newExpenseId, setNewExpenseId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const locked = event.status !== "draft";

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (!expenses.length) setLoading(true);
    else setRefreshing(true);
    setError("");
    eventRequest<{ expenses: Expense[] }>(
      token,
      "expenses.list",
      { eventId: event.id },
      { signal: controller.signal },
    )
      .then((result) => {
        if (active) setExpenses(result.expenses);
      })
      .catch((reason) => {
        if (active && (reason as RequestFailure)?.kind !== "cancelled")
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить расходы.",
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
    // Keep loaded rows visible during refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, event.id, revision]);

  useEffect(() => {
    if (!newExpenseId) return;
    const timeout = window.setTimeout(() => setNewExpenseId(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [newExpenseId]);

  useEffect(() => {
    const draft = restoredDraft.current;
    if (!draft || draft.mode !== "edit" || form || loading) return;
    const target = expenses.find((expense) => expense.id === draft.expenseId);
    if (target) {
      editingVersion.current = draft.eventVersion;
      editingExpenseVersion.current = draft.expenseVersion;
      setForm(target);
    } else {
      clearLocalState(userId, event.id, "expense-form", "draft");
      setError("Черновик относится к удалённому расходу и был очищен.");
    }
    restoredDraft.current = null;
  }, [event.id, expenses, form, loading, userId]);

  const persistDraft = (
    nextTitle: string,
    nextAmount: string,
    nextSelected: string[],
  ) => {
    saveLocalState(userId, event.id, "expense-form", "draft", {
      mode: form === "new" ? "new" : "edit",
      expenseId: form && form !== "new" ? form.id : null,
      expenseVersion: editingExpenseVersion.current,
      title: nextTitle,
      amount: nextAmount,
      selected: nextSelected,
      eventVersion: editingVersion.current,
    } satisfies ExpenseDraft);
  };

  const open = (target: "new" | Expense) => {
    setError("");
    setNotice("");
    setDeleting(null);
    setDetail(null);
    editingVersion.current = event.version;
    if (target === "new") {
      const draft = loadLocalState(
        userId,
        event.id,
        "expense-form",
        "draft",
        validDraft,
      );
      setTitle(draft?.mode === "new" ? draft.title : "");
      setAmount(draft?.mode === "new" ? draft.amount : "");
      setSelected(
        draft?.mode === "new"
          ? draft.selected.filter((id) =>
              event.members.some((member) => member.id === id),
            )
          : event.members.map((member) => member.id),
      );
      if (draft?.mode === "new") editingVersion.current = draft.eventVersion;
      editingExpenseVersion.current = null;
    } else {
      const draft = loadLocalState(
        userId,
        event.id,
        "expense-form",
        "draft",
        validDraft,
      );
      if (draft?.mode === "edit" && draft.expenseId === target.id) {
        setTitle(draft.title);
        setAmount(draft.amount);
        setSelected(
          draft.selected.filter((id) =>
            event.members.some((member) => member.id === id),
          ),
        );
        editingVersion.current = draft.eventVersion;
        editingExpenseVersion.current = draft.expenseVersion;
      } else {
        setTitle(target.title);
        setAmount(rublesInput(target.amount_kopecks));
        setSelected(target.shares.map((share) => share.user_id));
        editingExpenseVersion.current = target.version;
      }
    }
    setForm(target);
  };

  const submit = async (request: Pending) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPending(request);
    saveLocalState(userId, event.id, "expense-mutation", "pending", request);
    try {
      const result = await eventRequest<{ expenseId?: string }>(
        token,
        request.action,
        request.data,
      );
      clearLocalState(userId, event.id, "expense-mutation", "pending");
      clearLocalState(userId, event.id, "expense-form", "draft");
      setPending(null);
      setForm(null);
      setDetail(null);
      setDeleting(null);
      if (request.action === "expenses.create" && result.expenseId)
        setNewExpenseId(result.expenseId);
      setNotice(
        request.action === "expenses.delete"
          ? "Расход удалён."
          : request.action === "expenses.update"
            ? "Расход обновлён."
            : "Расход добавлен.",
      );
      setRevision((value) => value + 1);
      onChanged();
    } catch (reason) {
      if (!shouldKeepPendingMutation(reason)) {
        clearLocalState(userId, event.id, "expense-mutation", "pending");
        setPending(null);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить расход.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const saveForm = () => {
    if (!form) return;
    const kopecks = parseRubles(amount);
    if (kopecks === null || !selected.length || !title.trim()) {
      setError(
        "Укажите название, корректную сумму и хотя бы одного участника.",
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
          : { expenseId: form.id, version: editingExpenseVersion.current }),
      },
    });
  };

  const visible = onlyMine
    ? expenses.filter((expense) => expense.author_id === userId)
    : expenses;
  const groups = visible.reduce<Record<string, Expense[]>>(
    (result, expense) => {
      const day = expense.created_at
        ? new Date(expense.created_at).toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })
        : "Без даты";
      (result[day] ??= []).push(expense);
      return result;
    },
    {},
  );
  const payer =
    form && form !== "new"
      ? form.author_name
      : event.members.find((member) => member.id === userId)?.displayName;

  return (
    <section className="expenses-panel">
      <div className="list-toolbar">
        <div
          className="compact-segmented"
          role="group"
          aria-label="Фильтр расходов"
        >
          <button
            className={!onlyMine ? "active" : ""}
            onClick={() => onOnlyMine(false)}
          >
            Все
          </button>
          <button
            className={onlyMine ? "active" : ""}
            onClick={() => onOnlyMine(true)}
          >
            Оплатил я
          </button>
        </div>
        <button
          className="icon-refresh"
          disabled={busy || loading}
          onClick={() => setRevision((value) => value + 1)}
          aria-label="Обновить расходы"
        >
          {refreshing ? "…" : "↻"}
        </button>
      </div>
      {error && !form && (
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
          <p>
            Ответ сервера неизвестен. Повтор с сохранённым requestId безопасен.
          </p>
          <div className="actions">
            <button onClick={() => void submit(pending)}>Повторить</button>
            <button
              className="secondary"
              onClick={() => {
                clearLocalState(
                  userId,
                  event.id,
                  "expense-mutation",
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
      {loading && !expenses.length && <p role="status">Загружаем расходы…</p>}
      {!loading && !visible.length && !error && (
        <div className="empty-state compact-empty">
          <h3>
            {onlyMine ? "Вы пока ничего не оплатили" : "Расходов пока нет"}
          </h3>
          <p>
            {onlyMine
              ? "Переключитесь на все расходы мероприятия."
              : "Добавьте первую покупку, чтобы начать общий расчёт."}
          </p>
        </div>
      )}
      <div className="expense-list">
        {Object.entries(groups).map(([day, items]) => (
          <section className="expense-day" key={day}>
            <h3>{day}</h3>
            <m.div className="day-card" layout>
              <AnimatePresence initial={false}>
                {items.map((expense) => (
                  <m.button
                    className={`expense-row ${newExpenseId === expense.id ? "expense-row--new" : ""}`}
                    key={expense.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    whileTap={{ scale: 0.985 }}
                    onClick={() => setDetail(expense)}
                  >
                    <span>
                      <strong>{expense.title}</strong>
                      <small>
                        {expense.author_id === userId
                          ? "Оплатили вы"
                          : `Оплатил(а) ${expense.author_name}`}{" "}
                        ·{" "}
                        {expense.shares.length === event.members.length
                          ? "на всех"
                          : `на ${expense.shares.length}`}
                      </small>
                    </span>
                    <b>{formatDisplayMoney(expense.amount_kopecks)}</b>
                    <span aria-hidden="true">›</span>
                  </m.button>
                ))}
              </AnimatePresence>
            </m.div>
          </section>
        ))}
      </div>

      {!locked && (
        <div className="floating-action">
          <m.button
            className="primary-action"
            disabled={busy || form !== null}
            onClick={() => open("new")}
            whileTap={{ scale: 0.98 }}
          >
            <span aria-hidden="true">＋</span> Добавить расход
          </m.button>
        </div>
      )}

      <AnimatePresence>
        {form && (
          <m.section className="subscreen" {...pageTransition}>
            <ScreenHeader
              title={form === "new" ? "Новый расход" : "Редактирование"}
              back={() => setForm(null)}
            />
            <form
              className="screen-content expense-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveForm();
              }}
            >
              <label className="amount-label">
                Сумма, ₽
                <input
                  className="amount-input"
                  required
                  inputMode="decimal"
                  placeholder="0,00"
                  value={amount}
                  disabled={busy}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    persistDraft(title, event.target.value, selected);
                  }}
                />
              </label>
              <label>
                Название
                <input
                  required
                  maxLength={120}
                  value={title}
                  disabled={busy}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    persistDraft(event.target.value, amount, selected);
                  }}
                  placeholder="Ужин"
                />
              </label>
              <div className="payer-row">
                <span>Плательщик</span>
                <strong>
                  {payer}
                  {form === "new" ? " (вы)" : ""}
                </strong>
              </div>
              {event.version !== editingVersion.current && (
                <p className="warning-box" role="alert">
                  Мероприятие изменилось во время редактирования. Обновите
                  данные перед сохранением.
                </p>
              )}
              <fieldset disabled={busy} className="member-picker">
                <legend>Разделить поровну между</legend>
                {event.members.map((member) => (
                  <label className="share-choice" key={member.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(member.id)}
                      onChange={(change) => {
                        const next = change.target.checked
                          ? [...selected, member.id]
                          : selected.filter((id) => id !== member.id);
                        setSelected(next);
                        persistDraft(title, amount, next);
                      }}
                    />
                    <span>
                      {member.displayName}
                      {member.id === userId ? " (вы)" : ""}
                    </span>
                  </label>
                ))}
              </fieldset>
              <m.button
                className="form-submit"
                type="submit"
                disabled={
                  busy ||
                  locked ||
                  !selected.length ||
                  !title.trim() ||
                  parseRubles(amount) === null
                }
                whileTap={{ scale: 0.98 }}
              >
                {busy
                  ? "Сохраняем…"
                  : form === "new"
                    ? "Добавить расход"
                    : "Сохранить изменения"}
              </m.button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  clearLocalState(userId, event.id, "expense-form", "draft");
                  setTitle("");
                  setAmount("");
                  setSelected(event.members.map((member) => member.id));
                }}
              >
                Очистить черновик
              </button>
              {error && (
                <div className="error-box" role="alert">
                  <p>{error}</p>
                </div>
              )}
            </form>
          </m.section>
        )}
      </AnimatePresence>

      <BottomSheet
        open={detail !== null}
        onClose={() => {
          setDetail(null);
          setDeleting(null);
        }}
        title="Подробности расхода"
        className="expense-detail-sheet"
      >
        {detail && !deleting && (
          <>
            <h2>{detail.title}</h2>
            <p className="muted">
              {new Date(detail.created_at).toLocaleDateString("ru-RU", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </p>
            <strong className="detail-amount">
              {formatMoney(detail.amount_kopecks)}
            </strong>
            <p>Оплатил(а): {detail.author_name}</p>
            <h3>Разделено поровну</h3>
            <ul className="detail-shares">
              {detail.shares.map((share) => (
                <li key={share.user_id}>
                  <span>{share.display_name}</span>
                  <strong>{formatMoney(share.amount_kopecks)}</strong>
                </li>
              ))}
            </ul>
            {!locked &&
              (detail.author_id === userId || event.creatorId === userId) && (
                <div className="actions">
                  <button onClick={() => open(detail)}>Изменить</button>
                  <button
                    className="secondary danger"
                    onClick={() => setDeleting(detail)}
                  >
                    Удалить
                  </button>
                </div>
              )}
          </>
        )}
        {deleting && (
          <div className="confirmation" role="alert">
            <h3>Удалить «{deleting.title}»?</h3>
            <p>Запись об удалении останется в истории.</p>
            <div className="actions">
              <button
                disabled={busy || locked}
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
                Удалить
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </BottomSheet>
    </section>
  );
}
