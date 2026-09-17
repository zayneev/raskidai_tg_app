import { Expenses } from "./Expenses";
import { Settlements } from "./Settlements";
import { EventHistory } from "./EventHistory";
import { useEffect, useRef, useState } from "react";
import {
  eventRequest,
  type EventDetails,
  type EventSummary,
} from "./events-api";
import { invitationLink, launchInvitation } from "./invitations";
import { listenForSafeRefresh } from "./lifecycle";
import {
  clearLocalState,
  isRecord,
  loadLocalState,
  saveLocalState,
} from "./local-state";
import { RequestFailure, shouldKeepPendingMutation } from "./resilience";
import { Logo, MoneySummary, useFinancials } from "./visual";

const statusNames = {
  draft: "Собираем компанию",
  settled: "Расчёт зафиксирован",
  completed: "Завершено",
};
function participants(count: number) {
  return count % 10 === 1 && count % 100 !== 11 ? "участник" : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? "участника" : "участников";
}
function EventCard({ item, token, userId }: { item: EventSummary; token: string; userId: string }) {
  const summary = useFinancials(token, item.id, userId, item.version);
  return <a className="panel event-card" href={`#/events/${item.id}`}>
    <h2>{item.title}</h2>
    <p className="event-date">Дата мероприятия не указана</p>
    <MoneySummary total={summary.total} paid={summary.paid} balance={summary.balance} loading={!summary.value && !summary.error} unavailable={!summary.value && !!summary.error} />
    {summary.error && <small className="muted">Не удалось загрузить суммы</small>}
  </a>;
}
function routeId() {
  return (
    window.location.hash.match(/^#\/events\/([a-f0-9-]{36})$/i)?.[1] ?? null
  );
}
type PendingEvent = { action: string; data: Record<string, unknown> };
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validPending = (value: unknown): value is PendingEvent =>
  isRecord(value) &&
  ["create", "join", "rotate", "disable", "leave"].includes(
    String(value.action),
  ) &&
  isRecord(value.data) &&
  typeof value.data.requestId === "string" &&
  uuid.test(value.data.requestId);
type EventDraft = { title: string; description: string; requestId: string };
const validEventDraft = (value: unknown): value is EventDraft =>
  isRecord(value) &&
  typeof value.title === "string" &&
  value.title.length <= 120 &&
  typeof value.description === "string" &&
  value.description.length <= 2000 &&
  typeof value.requestId === "string" &&
  uuid.test(value.requestId);
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
  const [creating, setCreating] = useState(!!restoredDraft.current);
  const [title, setTitle] = useState(restoredDraft.current?.title ?? "");
  const [description, setDescription] = useState(
    restoredDraft.current?.description ?? "",
  );
  const requestId = useRef(
    restoredDraft.current?.requestId ?? crypto.randomUUID(),
  );
  const [invitation, setInvitation] = useState(() =>
    launchInvitation(window.Telegram?.WebApp.initData ?? "", location.search),
  );
  const [link, setLink] = useState("");
  const [confirm, setConfirm] = useState<"rotate" | "disable" | "leave" | null>(
    null,
  );
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
  const [tab, setTab] = useState<"expenses" | "transfers">("expenses");
  const overview = useFinancials(token, eventId ?? "", userId, revision);
  const inFlight = useRef(false);
  const go = (id: string | null) => {
    window.location.hash = id ? `/events/${id}` : "/events";
  };
  useEffect(() => {
    const onHash = () => {
      const nextEventId = routeId();
      setEventId(nextEventId);
      setEvent(null);
      setLink("");
      setConfirm(null);
      setNotice("");
      setTab("expenses");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    return listenForSafeRefresh({
      windowTarget: window,
      documentTarget: document,
      isOnline: () => navigator.onLine,
      isVisible: () => document.visibilityState === "visible",
      onOnlineChange: setOnline,
      onRefresh: () => setRevision((value) => value + 1),
    });
  }, []);
  useEffect(() => {
    const update = () => document.documentElement.classList.toggle("keyboard-open", !!window.visualViewport && window.innerHeight - window.visualViewport.height > 130);
    window.visualViewport?.addEventListener("resize", update);
    update();
    return () => { window.visualViewport?.removeEventListener("resize", update); document.documentElement.classList.remove("keyboard-open"); };
  }, []);
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
      } catch (e) {
        if (active && (e as RequestFailure)?.kind !== "cancelled")
          setError(e instanceof Error ? e.message : "Ошибка загрузки.");
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
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось выполнить действие.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const persistDraft = (nextTitle: string, nextDescription: string) => {
    if (pendingMutation?.action === "create") {
      clearLocalState(userId, null, "event-create", "pending");
      setPendingMutation(null);
      requestId.current = crypto.randomUUID();
    }
    saveLocalState(userId, null, "event-create", "draft", {
      title: nextTitle,
      description: nextDescription,
      requestId: requestId.current,
    });
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
  const change = (action: "rotate" | "disable" | "leave") =>
    void submitMutation(
      { action, data: { eventId, requestId: crypto.randomUUID() } },
      eventId,
      "event-mutation",
      (result) => {
        if (routeId() !== eventId) {
          setRevision((v) => v + 1);
          return;
        }
        setConfirm(null);
        if (action === "leave") {
          go(null);
          setRevision((v) => v + 1);
          return;
        }
        setLink(
          typeof result.invitation === "string"
            ? invitationLink(result.invitation)
            : "",
        );
        setNotice(
          action === "disable"
            ? "Приглашение отключено."
            : "Новая ссылка готова. Скопируйте её и отправьте друзьям.",
        );
        setRevision((v) => v + 1);
      },
    );
  return (
    <main className="app events-app">
      <header className="header">
        {eventId ? <a className="header-control" href="#/events" aria-label="К мероприятиям">‹</a> : <span className="header-spacer" />}
        <a className="brand" href="#/events" aria-label="раскидай — главная"><Logo /></a>
        <details className="header-menu"><summary className="header-control" aria-label="Меню">···</summary><div className="header-menu-content"><span>{displayName}</span><button disabled={busy} onClick={() => void logout()}>Выйти</button></div></details>
      </header>
      {!online && (
        <div className="offline-banner" role="status">
          Нет сети. Показаны последние загруженные данные; формы сохранены.
        </div>
      )}
      {invitation && (
        <section className="panel invite-panel">
          <h2>Вас пригласили в мероприятие</h2>
          <p>Присоединитесь, чтобы увидеть название и участников.</p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() => {
                const request = {
                  action: "join",
                  data: { invitation, requestId: crypto.randomUUID() },
                };
                void submitMutation(
                  request,
                  null,
                  "event-mutation",
                  (result) => {
                    setInvitation(null);
                    go(String(result.eventId));
                    setRevision((v) => v + 1);
                  },
                );
              }}
            >
              Присоединиться
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setInvitation(null)}
            >
              Не сейчас
            </button>
          </div>
        </section>
      )}
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
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {pendingMutation && (
        <section className="panel confirmation" role="status">
          <h2>Найден незавершённый запрос</h2>
          <p>
            Сервер мог выполнить действие. Можно безопасно повторить точное
            сохранённое тело с тем же requestId или отказаться от повтора.
          </p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void submitMutation(
                  pendingMutation,
                  pendingMutation.action === "create" ? null : eventId,
                  pendingMutation.action === "create"
                    ? "event-create"
                    : "event-mutation",
                  (result) => {
                    if (pendingMutation.action === "create") {
                      clearLocalState(userId, null, "event-create", "draft");
                      go(String(result.eventId));
                    } else if (pendingMutation.action === "join") {
                      setInvitation(null);
                      go(String(result.eventId));
                    } else if (pendingMutation.action === "leave") {
                      go(null);
                    } else {
                      if (
                        pendingMutation.action === "rotate" &&
                        typeof result.invitation === "string"
                      )
                        setLink(invitationLink(result.invitation));
                      setRevision((value) => value + 1);
                    }
                  },
                )
              }
            >
              Повторить тот же запрос
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                const create = pendingMutation.action === "create";
                clearLocalState(
                  userId,
                  create ? null : eventId,
                  create ? "event-create" : "event-mutation",
                  "pending",
                );
                setPendingMutation(null);
                if (create) {
                  requestId.current = crypto.randomUUID();
                  saveLocalState(userId, null, "event-create", "draft", {
                    title,
                    description,
                    requestId: requestId.current,
                  });
                }
              }}
            >
              Не повторять
            </button>
          </div>
        </section>
      )}
      {!eventId && <div className="page-heading"><h1>Мои мероприятия</h1><button className="small-button" disabled={loading || busy} onClick={() => setRevision((v) => v + 1)}>{refreshing ? "Обновляем…" : "Обновить"}</button></div>}
      {loading && <p role="status">Загружаем…</p>}
      {!eventId && (
        <>
          {creating && <button className="secondary" disabled={busy} onClick={() => setCreating(false)}>← К мероприятиям</button>}
          {creating && (
            <form
              className="panel event-form"
              onSubmit={(e) => {
                e.preventDefault();
                const request = {
                  action: "create",
                  data: { title, description, requestId: requestId.current },
                };
                void submitMutation(request, null, "event-create", (result) => {
                  requestId.current = crypto.randomUUID();
                  clearLocalState(userId, null, "event-create", "draft");
                  setTitle("");
                  setDescription("");
                  setCreating(false);
                  go(String(result.eventId));
                });
              }}
            >
              <h2>Что планируем?</h2>
              <label>
                Название
                <input
                  required
                  maxLength={120}
                  value={title}
                  disabled={busy}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    persistDraft(e.target.value, description);
                  }}
                  placeholder="Выходные у озера"
                />
              </label>
              <label>
                Описание <span className="muted">(необязательно)</span>
                <textarea
                  maxLength={2000}
                  value={description}
                  disabled={busy}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    persistDraft(title, e.target.value);
                  }}
                  placeholder="Где, когда и что взять с собой"
                />
              </label>
              <p className="muted">
                До 30 участников, включая вас. Валюта — рубли.
              </p>
              <button disabled={busy || !title.trim()} type="submit">
                {busy ? "Создаём…" : "Создать"}
              </button>
            </form>
          )}
          {!loading && !error && events.length === 0 && (
            <section className="panel empty-state">
              <h2>Всё начинается со встречи</h2>
              <p>Создайте мероприятие и пригласите друзей по ссылке.</p>
            </section>
          )}
          {!loading && (
            <div className="event-list">
              {events.map((item) => <EventCard key={item.id} item={item} token={token} userId={userId} />)}
            </div>
          )}
          {!creating && <div className="bottom-bar"><button className="primary-action" disabled={busy} onClick={() => setCreating(true)}><span aria-hidden="true">＋</span> Новое мероприятие</button></div>}
        </>
      )}
      {!loading && event && (
        <>
          <section className="event-overview">
            <h1 className="event-title">{event.title}</h1>
            <p className="event-meta">Дата не указана · {event.members.length} {participants(event.members.length)}</p>
            {event.description && <p className="description">{event.description}</p>}
            <MoneySummary total={overview.total} paid={overview.paid} balance={overview.balance} loading={!overview.value && !overview.error} unavailable={!overview.value && !!overview.error} />
            {overview.error && <p className="muted">Суммы недоступны: {overview.error}</p>}
          </section>
          <div className="tabs" role="tablist" aria-label="Разделы мероприятия">
            <button role="tab" aria-selected={tab === "expenses"} className={tab === "expenses" ? "active" : ""} onClick={() => setTab("expenses")}>Расходы</button>
            <button role="tab" aria-selected={tab === "transfers"} className={tab === "transfers" ? "active" : ""} onClick={() => setTab("transfers")}>Переводы</button>
          </div>
          {tab === "expenses" ? <Expenses key={event.id} token={token} userId={userId} event={event} onChanged={() => setRevision((value) => value + 1)} /> : <Settlements token={token} userId={userId} event={event} onChanged={() => setRevision((value) => value + 1)} />}
          <details className="event-management">
            <summary>Участники и настройки · {statusNames[event.status]}</summary>
          <section className="panel">
            <h2>
              Участники <span className="muted">{event.members.length}/30</span>
            </h2>
            <ul className="member-list">
              {event.members.map((member) => (
                <li key={member.id}>
                  <span className="avatar" aria-hidden="true">
                    {member.displayName.slice(0, 1)}
                  </span>
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
          </section>
          {event.creatorId === userId ? (
            <section className="panel">
              <h2>Пригласить друзей</h2>
              <p>
                {event.invitationActive
                  ? "Ссылка активна."
                  : "Активной ссылки пока нет."}
              </p>
              {link && (
                <label>
                  Ссылка-приглашение
                  <input
                    readOnly
                    value={link}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await navigator.clipboard.writeText(link);
                        setNotice("Ссылка скопирована.");
                      })
                    }
                  >
                    Скопировать ссылку
                  </button>
                </label>
              )}
              <p className="muted">
                Новая ссылка заменит предыдущую. Скопируйте её сейчас: после
                закрытия экрана потребуется создать новую.
              </p>
              <div className="actions">
                <button
                  disabled={busy || event.status !== "draft"}
                  onClick={() =>
                    event.invitationActive
                      ? setConfirm("rotate")
                      : change("rotate")
                  }
                >
                  {event.invitationActive
                    ? "Обновить ссылку"
                    : "Создать ссылку"}
                </button>
                {event.invitationActive && (
                  <button
                    className="secondary"
                    disabled={busy || event.status !== "draft"}
                    onClick={() => setConfirm("disable")}
                  >
                    Отключить ссылку
                  </button>
                )}
              </div>
            </section>
          ) : (
            <button
              className="danger secondary"
              disabled={busy || event.status !== "draft"}
              onClick={() => setConfirm("leave")}
            >
              Выйти из мероприятия
            </button>
          )}
          {confirm && (
            <section className="panel confirmation" role="alert">
              <h2>
                {confirm === "leave"
                  ? "Выйти из мероприятия?"
                  : confirm === "rotate"
                    ? "Заменить ссылку?"
                    : "Отключить приглашение?"}
              </h2>
              <p>
                {confirm === "leave"
                  ? "Мероприятие исчезнет из вашего списка. Для возвращения понадобится действующая ссылка."
                  : "Старая ссылка перестанет принимать новых участников. Те, кто уже присоединился, останутся."}
              </p>
              <div className="actions">
                <button disabled={busy} onClick={() => change(confirm)}>
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
            </section>
          )}
          </details>
          <EventHistory
            token={token}
            eventId={event.id}
            revision={event.version}
          />
        </>
      )}
    </main>
  );
}
