import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Expenses } from "./Expenses";
import { Settlements } from "./Settlements";
import { EventHistory } from "./EventHistory";
import {
  eventRequest,
  type EventDetails,
  type EventSummary,
} from "./events-api";
import {
  eventCategories,
  eventCategoryLabels,
  inferEventCategory,
  isEventCategory,
  type EventCategory,
} from "./event-categories";
import { invitationLink, launchInvitation } from "./invitations";
import { listenForSafeRefresh } from "./lifecycle";
import {
  clearLocalState,
  isRecord,
  loadLocalState,
  saveLocalState,
} from "./local-state";
import { RequestFailure, shouldKeepPendingMutation } from "./resilience";
import { BottomSheet, ScreenHeader, pageTransition } from "./ui";
import { EventCategoryIcon, MoneySummary, useFinancials } from "./visual";
import { formatDisplayMoney } from "./money";

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function routeId() {
  return (
    window.location.hash.match(/^#\/events\/([a-f0-9-]{36})$/i)?.[1] ?? null
  );
}

function formatEventDate(value: string | null) {
  if (!value) return "Дата не указана";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function participants(count: number) {
  if (count % 10 === 1 && count % 100 !== 11) return "участник";
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100))
    return "участника";
  return "участников";
}

type PendingEvent = { action: string; data: Record<string, unknown> };
const validPending = (value: unknown): value is PendingEvent =>
  isRecord(value) &&
  ["create", "join", "rotate", "disable", "leave"].includes(
    String(value.action),
  ) &&
  isRecord(value.data) &&
  typeof value.data.requestId === "string" &&
  uuid.test(value.data.requestId);

type EventDraft = {
  title: string;
  description: string;
  category: EventCategory;
  categoryManual: boolean;
  eventDate: string;
  requestId: string;
};
const validEventDraft = (value: unknown): value is EventDraft =>
  isRecord(value) &&
  typeof value.title === "string" &&
  value.title.length <= 120 &&
  typeof value.description === "string" &&
  value.description.length <= 300 &&
  isEventCategory(value.category) &&
  typeof value.categoryManual === "boolean" &&
  typeof value.eventDate === "string" &&
  (value.eventDate === "" || /^\d{4}-\d{2}-\d{2}$/.test(value.eventDate)) &&
  typeof value.requestId === "string" &&
  uuid.test(value.requestId);

function EventCard({
  item,
  token,
  userId,
}: {
  item: EventSummary;
  token: string;
  userId: string;
}) {
  const summary = useFinancials(token, item.id, userId, item.version);
  const unavailable = !summary.value && !!summary.error;
  return (
    <m.a
      className="event-card"
      href={`#/events/${item.id}`}
      layout
      whileTap={{ scale: 0.98 }}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24 }}
    >
      <div className="event-card-heading">
        <EventCategoryIcon category={item.category ?? "other"} />
        <h2>{item.title}</h2>
      </div>
      <div
        className="event-card-metrics"
        aria-busy={!summary.value && !summary.error}
      >
        <div>
          <span>Всего потрачено</span>
          <strong>
            {unavailable || !summary.value
              ? "—"
              : formatDisplayMoney(summary.total)}
          </strong>
        </div>
        <div>
          <span>Вы потратили</span>
          <strong>
            {unavailable || !summary.value
              ? "—"
              : formatDisplayMoney(summary.paid)}
          </strong>
        </div>
      </div>
    </m.a>
  );
}

function CreationScreen({
  title,
  description,
  category,
  eventDate,
  busy,
  restored,
  onBack,
  onClear,
  onTitle,
  onDescription,
  onDate,
  onChooseCategory,
  onSubmit,
}: {
  title: string;
  description: string;
  category: EventCategory;
  eventDate: string;
  busy: boolean;
  restored: boolean;
  onBack: () => void;
  onClear: () => void;
  onTitle: (value: string) => void;
  onDescription: (value: string) => void;
  onDate: (value: string) => void;
  onChooseCategory: () => void;
  onSubmit: () => void;
}) {
  return (
    <m.section className="screen creation-screen" {...pageTransition}>
      <ScreenHeader title="Новое мероприятие" back={onBack} />
      <form
        className="screen-content creation-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="form-intro">
          <h1>Что планируем?</h1>
          <p>Название поможет подобрать иконку. Всё можно изменить позже.</p>
        </div>
        {restored && (
          <div className="draft-note" role="status">
            <span>Черновик восстановлен</span>
            <button type="button" className="text-button" onClick={onClear}>
              Очистить
            </button>
          </div>
        )}
        <label>
          Название
          <input
            required
            maxLength={120}
            value={title}
            disabled={busy}
            onChange={(event) => onTitle(event.target.value)}
            placeholder="Выходные у озера"
          />
        </label>
        <button
          type="button"
          className="category-choice"
          onClick={onChooseCategory}
          disabled={busy}
        >
          <EventCategoryIcon category={category} />
          <span>
            <small>Категория</small>
            <strong>{eventCategoryLabels[category]}</strong>
          </span>
          <span aria-hidden="true">›</span>
        </button>
        <label>
          Дата <span className="muted">(необязательно)</span>
          <input
            type="date"
            value={eventDate}
            disabled={busy}
            onChange={(event) => onDate(event.target.value)}
          />
        </label>
        <label>
          Краткое описание <span className="muted">(необязательно)</span>
          <textarea
            maxLength={300}
            value={description}
            disabled={busy}
            onChange={(event) => onDescription(event.target.value)}
            placeholder="Где встречаемся и что взять с собой"
          />
          <small className="field-counter">{description.length}/300</small>
        </label>
        <m.button
          className="form-submit"
          type="submit"
          disabled={busy || !title.trim()}
          whileTap={{ scale: 0.98 }}
        >
          {busy ? "Создаём…" : "Создать мероприятие"}
        </m.button>
      </form>
    </m.section>
  );
}

export function Events({
  token,
  userId,
  displayName,
  logout,
  onReady,
}: {
  token: string;
  userId: string;
  displayName: string;
  logout: () => Promise<void>;
  onReady: () => void;
}) {
  const [eventId, setEventId] = useState(routeId);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [event, setEvent] = useState<EventDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const restoredDraft = useRef(
    loadLocalState(userId, null, "event-create", "draft", validEventDraft),
  );
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState(restoredDraft.current?.title ?? "");
  const [description, setDescription] = useState(
    restoredDraft.current?.description ?? "",
  );
  const [category, setCategory] = useState<EventCategory>(
    restoredDraft.current?.category ?? "other",
  );
  const [categoryManual, setCategoryManual] = useState(
    restoredDraft.current?.categoryManual ?? false,
  );
  const [eventDate, setEventDate] = useState(
    restoredDraft.current?.eventDate ?? "",
  );
  const requestId = useRef(
    restoredDraft.current?.requestId ?? crypto.randomUUID(),
  );
  const [categoryPicker, setCategoryPicker] = useState(false);
  const [created, setCreated] = useState<{
    id: string;
    title: string;
    category: EventCategory;
    eventDate: string | null;
    link: string;
  } | null>(null);
  const [invitation, setInvitation] = useState(() =>
    launchInvitation(window.Telegram?.WebApp.initData ?? "", location.search),
  );
  const [link, setLink] = useState("");
  const [confirm, setConfirm] = useState<"rotate" | "disable" | "leave" | null>(
    null,
  );
  const [eventPanel, setEventPanel] = useState<
    "menu" | "participants" | "invite" | "history" | "settings" | null
  >(null);
  const [pendingMutation, setPendingMutation] = useState<PendingEvent | null>(
    () =>
      loadLocalState(
        userId,
        routeId(),
        "event-mutation",
        "pending",
        validPending,
      ) ??
      loadLocalState(userId, null, "event-create", "pending", validPending),
  );
  const [online, setOnline] = useState(() => navigator.onLine);
  const [tab, setTab] = useState<"expenses" | "calculation">("expenses");
  const [onlyMine, setOnlyMine] = useState(false);
  const scrollPositions = useRef({ expenses: 0, calculation: 0 });
  const overview = useFinancials(token, eventId ?? "", userId, revision);
  const inFlight = useRef(false);

  const go = (id: string | null) => {
    window.location.hash = id ? `/events/${id}` : "/events";
  };

  useEffect(() => {
    const onHash = () => {
      setEventId(routeId());
      setEvent(null);
      setEventPanel(null);
      setConfirm(null);
      setNotice("");
      setTab("expenses");
      scrollPositions.current = { expenses: 0, calculation: 0 };
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(
    () =>
      listenForSafeRefresh({
        windowTarget: window,
        documentTarget: document,
        isOnline: () => navigator.onLine,
        isVisible: () => document.visibilityState === "visible",
        onOnlineChange: setOnline,
        onRefresh: () => setRevision((value) => value + 1),
      }),
    [],
  );

  useEffect(() => {
    setPendingMutation(
      loadLocalState(
        userId,
        eventId,
        "event-mutation",
        "pending",
        validPending,
      ) ??
        (eventId === null
          ? loadLocalState(
              userId,
              null,
              "event-create",
              "pending",
              validPending,
            )
          : null),
    );
  }, [eventId, userId]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const initial = eventId ? event === null : events.length === 0;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError("");
    const load = async () => {
      try {
        if (eventId) {
          const value = await eventRequest<{ event: EventDetails }>(
            token,
            "get",
            { eventId },
            { signal: controller.signal },
          );
          if (active) setEvent(value.event);
        } else {
          const value = await eventRequest<{ events: EventSummary[] }>(
            token,
            "list",
            {},
            { signal: controller.signal },
          );
          if (active) setEvents(value.events);
        }
      } catch (reason) {
        if (active && (reason as RequestFailure)?.kind !== "cancelled")
          setError(
            reason instanceof Error ? reason.message : "Ошибка загрузки.",
          );
      } finally {
        if (active) {
          setLoading(false);
          setRefreshing(false);
          onReady();
        }
      }
    };
    void load();
    return () => {
      active = false;
      controller.abort();
    };
    // Existing data intentionally stays visible during background refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, eventId, revision]);

  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (reason) {
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

  const draftValue = (changes: Partial<EventDraft> = {}): EventDraft => ({
    title,
    description,
    category,
    categoryManual,
    eventDate,
    requestId: requestId.current,
    ...changes,
  });
  const persistDraft = (changes: Partial<EventDraft>) => {
    if (pendingMutation?.action === "create") {
      clearLocalState(userId, null, "event-create", "pending");
      setPendingMutation(null);
      requestId.current = crypto.randomUUID();
    }
    saveLocalState(userId, null, "event-create", "draft", draftValue(changes));
  };
  const clearDraft = () => {
    clearLocalState(userId, null, "event-create", "draft");
    setTitle("");
    setDescription("");
    setCategory("other");
    setCategoryManual(false);
    setEventDate("");
    requestId.current = crypto.randomUUID();
    restoredDraft.current = null;
  };

  const submitMutation = async (
    request: PendingEvent,
    scopeEventId: string | null,
    operation: "event-create" | "event-mutation",
    success: (result: Record<string, unknown>) => void,
  ) => {
    if (inFlight.current) return;
    saveLocalState(userId, scopeEventId, operation, "pending", request);
    setPendingMutation(request);
    await run(async () => {
      try {
        const result = await eventRequest<Record<string, unknown>>(
          token,
          request.action,
          request.data,
        );
        clearLocalState(userId, scopeEventId, operation, "pending");
        setPendingMutation(null);
        success(result);
      } catch (reason) {
        if (!shouldKeepPendingMutation(reason)) {
          clearLocalState(userId, scopeEventId, operation, "pending");
          setPendingMutation(null);
        }
        throw reason;
      }
    });
  };

  const createEvent = () => {
    const request: PendingEvent = {
      action: "create",
      data: {
        title,
        description,
        category,
        eventDate: eventDate || null,
        requestId: requestId.current,
      },
    };
    void submitMutation(request, null, "event-create", (result) => {
      const id = String(result.eventId);
      const tokenValue =
        typeof result.invitation === "string" ? result.invitation : "";
      clearLocalState(userId, null, "event-create", "draft");
      setCreated({
        id,
        title: title.trim(),
        category,
        eventDate: eventDate || null,
        link: tokenValue ? invitationLink(tokenValue) : "",
      });
      clearDraft();
      setCreating(false);
      setRevision((value) => value + 1);
    });
  };

  const change = (action: "rotate" | "disable" | "leave") =>
    void submitMutation(
      { action, data: { eventId, requestId: crypto.randomUUID() } },
      eventId,
      "event-mutation",
      (result) => {
        setConfirm(null);
        if (action === "leave") {
          setEventPanel(null);
          go(null);
          return;
        }
        if (typeof result.invitation === "string")
          setLink(invitationLink(result.invitation));
        setNotice(
          action === "disable"
            ? "Приглашение отключено."
            : "Новая ссылка готова.",
        );
        setRevision((value) => value + 1);
      },
    );

  const chooseTab = (next: "expenses" | "calculation") => {
    if (next === tab) return;
    scrollPositions.current[tab] = window.scrollY;
    setTab(next);
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        window.scrollTo({ top: scrollPositions.current[next] }),
      ),
    );
  };

  const share = (url: string, eventTitle: string) => {
    const target = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(`Присоединяйтесь к мероприятию «${eventTitle}» в раскидай`)}`;
    if (window.Telegram?.WebApp.openTelegramLink)
      window.Telegram.WebApp.openTelegramLink(target);
    else window.open(target, "_blank", "noopener,noreferrer");
  };

  const activeEvents = events.filter((item) => item.status !== "completed");
  const completedEvents = events.filter((item) => item.status === "completed");

  const renderEventPanel = () => {
    if (!event) return null;
    if (eventPanel === "participants")
      return (
        <>
          <h2>Участники</h2>
          <p className="muted">{event.members.length}/30</p>
          <ul className="member-list">
            {event.members.map((member) => (
              <li key={member.id}>
                <span>
                  {member.displayName}
                  {member.id === userId ? " (вы)" : ""}
                  <small>
                    {member.id === event.creatorId ? "Создатель" : "Участник"}
                  </small>
                </span>
              </li>
            ))}
          </ul>
          <button
            className="secondary sheet-back-action"
            onClick={() => setEventPanel("menu")}
          >
            ← К меню
          </button>
        </>
      );
    if (eventPanel === "invite")
      return (
        <>
          <h2>Приглашение</h2>
          {event.creatorId === userId ? (
            <>
              <p>
                {event.invitationActive
                  ? "Ссылка активна. Создайте новую, чтобы поделиться ей."
                  : "Активной ссылки пока нет."}
              </p>
              {link && (
                <>
                  <input
                    readOnly
                    value={link}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <div className="actions">
                    <button onClick={() => share(link, event.title)}>
                      Поделиться
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(link)
                          .then(() => setNotice("Ссылка скопирована."))
                      }
                    >
                      Скопировать
                    </button>
                  </div>
                </>
              )}
              <button
                disabled={busy || event.status !== "draft"}
                onClick={() =>
                  event.invitationActive
                    ? setConfirm("rotate")
                    : change("rotate")
                }
              >
                {event.invitationActive
                  ? "Создать новую ссылку"
                  : "Создать ссылку"}
              </button>
              {event.invitationActive && (
                <button
                  className="secondary danger standalone-action"
                  disabled={busy || event.status !== "draft"}
                  onClick={() => setConfirm("disable")}
                >
                  Отключить приглашение
                </button>
              )}
            </>
          ) : (
            <p>Новой ссылкой может поделиться создатель мероприятия.</p>
          )}
          <button
            className="secondary sheet-back-action"
            onClick={() => setEventPanel("menu")}
          >
            ← К меню
          </button>
        </>
      );
    if (eventPanel === "history")
      return (
        <>
          <EventHistory
            token={token}
            eventId={event.id}
            revision={event.version}
          />
          <button
            className="secondary sheet-back-action"
            onClick={() => setEventPanel("menu")}
          >
            ← К меню
          </button>
        </>
      );
    if (eventPanel === "settings")
      return (
        <>
          <h2>Настройки</h2>
          <p>
            <strong>{displayName}</strong>
          </p>
          <p className="muted">
            Статус:{" "}
            {event.status === "draft"
              ? "собираем расходы"
              : event.status === "settled"
                ? "идут переводы"
                : "завершено"}
          </p>
          {event.creatorId !== userId && (
            <button
              className="secondary danger standalone-action"
              disabled={busy || event.status !== "draft"}
              onClick={() => setConfirm("leave")}
            >
              Выйти из мероприятия
            </button>
          )}
          <button
            className="secondary standalone-action"
            disabled={busy}
            onClick={() => void logout()}
          >
            Выйти из аккаунта
          </button>
          <button
            className="secondary sheet-back-action"
            onClick={() => setEventPanel("menu")}
          >
            ← К меню
          </button>
        </>
      );
    return (
      <>
        <h2>Меню мероприятия</h2>
        <nav className="event-menu-list">
          <button onClick={() => setEventPanel("participants")}>
            Участники <span>{event.members.length} ›</span>
          </button>
          <button onClick={() => setEventPanel("invite")}>
            Приглашение <span>›</span>
          </button>
          <button onClick={() => setEventPanel("history")}>
            История <span>›</span>
          </button>
          <button onClick={() => setEventPanel("settings")}>
            Настройки <span>›</span>
          </button>
        </nav>
      </>
    );
  };

  return (
    <main className="app events-app">
      {!online && (
        <div className="offline-banner" role="status">
          Нет сети. Формы и незавершённые действия сохранены.
        </div>
      )}
      {error && (
        <div className="global-message error-box" role="alert">
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
        <p className="global-message notice" role="status">
          {notice}
        </p>
      )}

      <AnimatePresence mode="wait">
        {created ? (
          <m.section
            className="screen success-screen"
            key="created"
            {...pageTransition}
          >
            <ScreenHeader
              title="Готово"
              back={() => {
                setCreated(null);
                go(created.id);
              }}
            />
            <div className="screen-content success-content">
              <m.div
                className="success-mark"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                ✓
              </m.div>
              <EventCategoryIcon category={created.category} />
              <h1>Мероприятие создано</h1>
              <h2>{created.title}</h2>
              {created.eventDate && <p>{formatEventDate(created.eventDate)}</p>}
              {created.link ? (
                <>
                  <m.button
                    className="primary-action"
                    whileTap={{ scale: 0.98 }}
                    onClick={() => share(created.link, created.title)}
                  >
                    Поделиться в Telegram
                  </m.button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(created.link)
                        .then(() => setNotice("Ссылка скопирована."))
                    }
                  >
                    Скопировать ссылку
                  </button>
                </>
              ) : (
                <p className="warning-box">
                  Мероприятие создано. Ссылку можно создать в его меню.
                </p>
              )}
              <button
                className="text-button"
                onClick={() => {
                  setCreated(null);
                  go(created.id);
                }}
              >
                Перейти к мероприятию
              </button>
            </div>
          </m.section>
        ) : creating ? (
          <CreationScreen
            key="creating"
            title={title}
            description={description}
            category={category}
            eventDate={eventDate}
            busy={busy}
            restored={!!restoredDraft.current}
            onBack={() => setCreating(false)}
            onClear={clearDraft}
            onTitle={(value) => {
              const inferred = categoryManual
                ? category
                : inferEventCategory(value);
              setTitle(value);
              if (!categoryManual) setCategory(inferred);
              persistDraft({
                title: value,
                ...(categoryManual ? {} : { category: inferred }),
              });
            }}
            onDescription={(value) => {
              setDescription(value);
              persistDraft({ description: value });
            }}
            onDate={(value) => {
              setEventDate(value);
              persistDraft({ eventDate: value });
            }}
            onChooseCategory={() => setCategoryPicker(true)}
            onSubmit={createEvent}
          />
        ) : eventId && event ? (
          <m.section
            className="event-screen"
            key={event.id}
            {...pageTransition}
          >
            <ScreenHeader
              title={event.title}
              back={() => go(null)}
              action={
                <m.button
                  type="button"
                  className="header-control menu-control"
                  whileTap={{ scale: 0.94 }}
                  onClick={() => setEventPanel("menu")}
                  aria-label="Меню мероприятия"
                >
                  •••
                </m.button>
              }
            />
            <section className="event-overview">
              <div className="event-identity">
                <EventCategoryIcon category={event.category ?? "other"} />
                <div>
                  <span>{eventCategoryLabels[event.category ?? "other"]}</span>
                  <strong>{formatEventDate(event.eventDate)}</strong>
                </div>
              </div>
              {event.description && (
                <p className="description">{event.description}</p>
              )}
              <MoneySummary
                total={overview.total}
                paid={overview.paid}
                balance={overview.balance}
                loading={!overview.value && !overview.error}
                unavailable={!overview.value && !!overview.error}
              />
              <p className="event-members">
                {event.members.length} {participants(event.members.length)}
              </p>
            </section>
            <div
              className="tabs sticky-tabs"
              role="tablist"
              aria-label="Разделы мероприятия"
            >
              <button
                role="tab"
                aria-selected={tab === "expenses"}
                className={tab === "expenses" ? "active" : ""}
                onClick={() => chooseTab("expenses")}
              >
                Расходы
              </button>
              <button
                role="tab"
                aria-selected={tab === "calculation"}
                className={tab === "calculation" ? "active" : ""}
                onClick={() => chooseTab("calculation")}
              >
                Расчёт
              </button>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              {tab === "expenses" ? (
                <m.div
                  key="expenses"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.22 }}
                >
                  <Expenses
                    token={token}
                    userId={userId}
                    event={event}
                    onlyMine={onlyMine}
                    onOnlyMine={setOnlyMine}
                    onChanged={() => setRevision((value) => value + 1)}
                  />
                </m.div>
              ) : (
                <m.div
                  key="calculation"
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ duration: 0.22 }}
                >
                  <Settlements
                    token={token}
                    userId={userId}
                    event={event}
                    onChanged={() => setRevision((value) => value + 1)}
                  />
                </m.div>
              )}
            </AnimatePresence>
          </m.section>
        ) : !eventId ? (
          <m.section className="home-screen" key="home" {...pageTransition}>
            <ScreenHeader logo />
            <div className="home-content">
              <div className="page-heading">
                <h1>Мои мероприятия</h1>
                <button
                  className="small-button"
                  disabled={loading || busy}
                  onClick={() => setRevision((value) => value + 1)}
                >
                  {refreshing ? "Обновляем…" : "Обновить"}
                </button>
              </div>
              {invitation && (
                <section className="invite-card">
                  <h2>Вас пригласили</h2>
                  <p>Присоединитесь, чтобы увидеть мероприятие и участников.</p>
                  <div className="actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void submitMutation(
                          {
                            action: "join",
                            data: {
                              invitation,
                              requestId: crypto.randomUUID(),
                            },
                          },
                          null,
                          "event-mutation",
                          (result) => {
                            setInvitation(null);
                            go(String(result.eventId));
                          },
                        )
                      }
                    >
                      Присоединиться
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setInvitation(null)}
                    >
                      Не сейчас
                    </button>
                  </div>
                </section>
              )}
              {loading && !events.length && (
                <p role="status">Загружаем мероприятия…</p>
              )}
              {!loading && !error && events.length === 0 && (
                <section className="empty-state home-empty">
                  <EventCategoryIcon category="other" />
                  <h2>Пока нет мероприятий</h2>
                  <p>Создайте первую встречу и пригласите друзей.</p>
                </section>
              )}
              <div className="event-list">
                {activeEvents.map((item) => (
                  <EventCard
                    key={item.id}
                    item={item}
                    token={token}
                    userId={userId}
                  />
                ))}
              </div>
              {completedEvents.length > 0 && (
                <details className="completed-events">
                  <summary>
                    Завершённые <span>{completedEvents.length}⌄</span>
                  </summary>
                  <div className="event-list">
                    {completedEvents.map((item) => (
                      <EventCard
                        key={item.id}
                        item={item}
                        token={token}
                        userId={userId}
                      />
                    ))}
                  </div>
                </details>
              )}
            </div>
            <div className="floating-action">
              <m.button
                className="primary-action"
                disabled={busy}
                onClick={() => {
                  restoredDraft.current = loadLocalState(
                    userId,
                    null,
                    "event-create",
                    "draft",
                    validEventDraft,
                  );
                  setCreating(true);
                }}
                whileTap={{ scale: 0.98 }}
              >
                <span aria-hidden="true">＋</span> Добавить мероприятие
              </m.button>
            </div>
          </m.section>
        ) : (
          <m.section
            className="screen loading-screen"
            key="loading"
            {...pageTransition}
          >
            <ScreenHeader title="Мероприятие" back={() => go(null)} />
            <p className="screen-content" role="status">
              Загружаем мероприятие…
            </p>
          </m.section>
        )}
      </AnimatePresence>

      <BottomSheet
        open={categoryPicker}
        onClose={() => setCategoryPicker(false)}
        title="Выбор категории"
        className="category-sheet"
      >
        <h2>Категория</h2>
        <div className="category-grid">
          {eventCategories.map((item) => (
            <button
              type="button"
              className={category === item.value ? "selected" : ""}
              key={item.value}
              onClick={() => {
                setCategory(item.value);
                setCategoryManual(true);
                persistDraft({ category: item.value, categoryManual: true });
                setCategoryPicker(false);
              }}
            >
              <EventCategoryIcon category={item.value} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </BottomSheet>
      <BottomSheet
        open={eventPanel !== null}
        onClose={() => {
          setEventPanel(null);
          setConfirm(null);
        }}
        title="Меню мероприятия"
        className="event-menu-sheet"
      >
        {renderEventPanel()}
        {confirm && (
          <div className="confirmation" role="alert">
            <h3>
              {confirm === "leave"
                ? "Выйти из мероприятия?"
                : confirm === "rotate"
                  ? "Заменить ссылку?"
                  : "Отключить приглашение?"}
            </h3>
            <p>
              {confirm === "leave"
                ? "Для возвращения понадобится действующая ссылка."
                : "Старая ссылка перестанет принимать новых участников."}
            </p>
            <div className="actions">
              <button disabled={busy} onClick={() => change(confirm)}>
                Подтвердить
              </button>
              <button className="secondary" onClick={() => setConfirm(null)}>
                Отмена
              </button>
            </div>
          </div>
        )}
      </BottomSheet>

      {pendingMutation && !busy && (
        <div className="pending-toast" role="status">
          <span>Есть незавершённое действие</span>
          <button
            onClick={() =>
              void submitMutation(
                pendingMutation,
                pendingMutation.action === "create" ? null : eventId,
                pendingMutation.action === "create"
                  ? "event-create"
                  : "event-mutation",
                (result) => {
                  if (pendingMutation.action === "create") {
                    const id = String(result.eventId);
                    const invitationToken =
                      typeof result.invitation === "string"
                        ? result.invitation
                        : "";
                    setCreated({
                      id,
                      title,
                      category,
                      eventDate: eventDate || null,
                      link: invitationToken
                        ? invitationLink(invitationToken)
                        : "",
                    });
                    setCreating(false);
                  } else {
                    setRevision((value) => value + 1);
                  }
                },
              )
            }
          >
            Повторить
          </button>
        </div>
      )}
    </main>
  );
}
