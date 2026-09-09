import { Expenses } from "./Expenses";
import { Settlements } from "./Settlements";
import { useEffect, useRef, useState } from "react";
import {
  eventRequest,
  type EventDetails,
  type EventSummary,
} from "./events-api";
import { invitationLink, launchInvitation } from "./invitations";

const statusNames = {
  draft: "Собираем компанию",
  settled: "Расчёт зафиксирован",
  completed: "Завершено",
};
function routeId() {
  return (
    window.location.hash.match(/^#\/events\/([a-f0-9-]{36})$/i)?.[1] ?? null
  );
}
export function Events({
  token,
  userId,
  displayName,
  logout,
}: {
  token: string;
  userId: string;
  displayName: string;
  logout: () => Promise<void>;
}) {
  const [eventId, setEventId] = useState(routeId);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [event, setEvent] = useState<EventDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const [invitation, setInvitation] = useState(() =>
    launchInvitation(window.Telegram?.WebApp.initData ?? "", location.search),
  );
  const [link, setLink] = useState("");
  const [confirm, setConfirm] = useState<"rotate" | "disable" | "leave" | null>(
    null,
  );
  const inFlight = useRef(false);
  const go = (id: string | null) => {
    window.location.hash = id ? `/events/${id}` : "/events";
  };
  useEffect(() => {
    const onHash = () => {
      setEventId(routeId());
      setLink("");
      setConfirm(null);
      setNotice("");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setEvent(null);
    const load = async () => {
      try {
        if (eventId) {
          const value = await eventRequest<{ event: EventDetails }>(
            token,
            "get",
            { eventId },
          );
          if (active) setEvent(value.event);
        } else {
          const value = await eventRequest<{ events: EventSummary[] }>(
            token,
            "list",
          );
          if (active) setEvents(value.events);
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "Ошибка загрузки.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
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
  const change = (action: "rotate" | "disable" | "leave") =>
    void run(async () => {
      const result = await eventRequest<{ invitation?: string }>(
        token,
        action,
        { eventId },
      );
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
      setLink(result.invitation ? invitationLink(result.invitation) : "");
      setNotice(
        action === "disable"
          ? "Приглашение отключено."
          : "Новая ссылка готова. Скопируйте её и отправьте друзьям.",
      );
      setRevision((v) => v + 1);
    });
  return (
    <main className="app events-app">
      <header className="header">
        <a className="brand" href="#/events">
          <span className="brand-icon">↗</span>раскидай
        </a>
        <button
          className="small-button"
          disabled={busy}
          onClick={() => void logout()}
        >
          Выйти из аккаунта
        </button>
      </header>
      <p className="greeting">{displayName}</p>
      {invitation && (
        <section className="panel invite-panel">
          <h2>Вас пригласили в мероприятие</h2>
          <p>Присоединитесь, чтобы увидеть название и участников.</p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await eventRequest<{ eventId: string }>(
                    token,
                    "join",
                    { invitation },
                  );
                  setInvitation(null);
                  go(result.eventId);
                  setRevision((v) => v + 1);
                })
              }
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
          {error}
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="page-heading">
        <h1>{eventId ? "Мероприятие" : "Мои мероприятия"}</h1>
        <button
          className="small-button"
          disabled={loading || busy}
          onClick={() => setRevision((v) => v + 1)}
        >
          Обновить
        </button>
      </div>
      {eventId && (
        <a className="back-link" href="#/events">
          ← Все мероприятия
        </a>
      )}
      {loading && <p role="status">Загружаем…</p>}
      {!eventId && (
        <>
          <button disabled={busy} onClick={() => setCreating((v) => !v)}>
            {creating ? "Скрыть форму" : "+ Создать мероприятие"}
          </button>
          {creating && (
            <form
              className="panel event-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const result = await eventRequest<{ eventId: string }>(
                    token,
                    "create",
                    { title, description, requestId: requestId.current },
                  );
                  requestId.current = crypto.randomUUID();
                  setTitle("");
                  setDescription("");
                  setCreating(false);
                  go(result.eventId);
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
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Выходные у озера"
                />
              </label>
              <label>
                Описание <span className="muted">(необязательно)</span>
                <textarea
                  maxLength={2000}
                  value={description}
                  disabled={busy}
                  onChange={(e) => setDescription(e.target.value)}
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
              <span aria-hidden="true">↗</span>
              <h2>Всё начинается со встречи</h2>
              <p>Создайте мероприятие и пригласите друзей по ссылке.</p>
            </section>
          )}
          {!loading && (
            <div className="event-list">
              {events.map((item) => (
                <a
                  className="panel event-card"
                  href={`#/events/${item.id}`}
                  key={item.id}
                >
                  <span className="badge">{statusNames[item.status]}</span>
                  <h2>{item.title}</h2>
                  <p>
                    {item.memberCount} из 30 участников
                    {item.creatorId === userId ? " · Вы создатель" : ""}
                  </p>
                  <span className="card-arrow" aria-hidden="true">
                    ↗
                  </span>
                </a>
              ))}
            </div>
          )}
        </>
      )}
      {!loading && event && (
        <>
          <section className="panel">
            <span className="badge">{statusNames[event.status]}</span>
            <h2 className="event-title">{event.title}</h2>
            {event.description && (
              <p className="description">{event.description}</p>
            )}
          </section>
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
          <Expenses
            key={event.id}
            token={token}
            userId={userId}
            event={event}
          />
          <Settlements
            token={token}
            userId={userId}
            event={event}
            onChanged={() => setRevision((value) => value + 1)}
          />
        </>
      )}
      <footer>Меньше подсчётов. Больше хороших встреч.</footer>
    </main>
  );
}
