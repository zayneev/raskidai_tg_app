import { useEffect, useState } from "react";
import { clearUserLocalState } from "./local-state";
import { requestJson, sessionExpiredEvent } from "./resilience";

declare global {
  interface Window {
    Telegram?: { WebApp: { initData: string; ready(): void; expand(): void } };
  }
}
type Session = {
  token: string;
  user: { id: string; displayName: string };
  expiresAt: string;
};
type AuthState =
  | {
      status: "loading" | "outside" | "unconfigured" | "signed-out" | "error";
      message?: string;
    }
  | { status: "authenticated"; session: Session };
// Only in memory: a reload exchanges fresh Telegram initData again.
let currentSession: Session | null = null;
let pending: Promise<Session> | null = null;
const baseUrl = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
async function request<T>(path: string, init: RequestInit): Promise<T> {
  return requestJson<T>(`${baseUrl}/functions/v1/${path}`, init, {
    timeoutMs: 15000,
    errorMessages: {
      invalid_init_data:
        "Данные Telegram не прошли проверку. Закройте Mini App и откройте его заново.",
      expired_init_data:
        "Данные входа Telegram истекли. Закройте Mini App и откройте его заново.",
      unauthorized: "Сессия истекла. Выполните вход через Telegram ещё раз.",
    },
  });
}
function login(initData: string): Promise<Session> {
  if (!pending) {
    pending = request<Session>("telegram-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    })
      .then(async (session: Session) => {
        // Confirm the issued session through the protected endpoint.
        const verified = await request<Omit<Session, "token">>("session", {
          headers: { Authorization: `Bearer ${session.token}` },
        });
        currentSession = { ...verified, token: session.token };
        return currentSession!;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}
export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const reauthenticate = () => {
      currentSession = null;
      setState({
        status: "loading",
        message: "Сессия истекла. Восстанавливаем вход через Telegram…",
      });
      setAttempt((value) => value + 1);
    };
    window.addEventListener(sessionExpiredEvent, reauthenticate);
    return () =>
      window.removeEventListener(sessionExpiredEvent, reauthenticate);
  }, []);
  useEffect(() => {
    let active = true;
    const app = window.Telegram?.WebApp;
    app?.ready();
    if (!app?.initData) {
      setState({ status: "outside" });
      return;
    }
    if (!baseUrl) {
      setState({ status: "unconfigured" });
      return;
    }
    app.expand();
    setState({ status: "loading" });
    const session =
      currentSession && Date.parse(currentSession.expiresAt) > Date.now()
        ? Promise.resolve(currentSession)
        : login(app.initData);
    session
      .then((value) => {
        if (active) setState({ status: "authenticated", session: value });
      })
      .catch((error) => {
        if (active)
          setState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Ошибка входа. Попробуйте ещё раз.",
          });
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (state.status !== "authenticated") return;
    const expire = () => {
      currentSession = null;
      setState({
        status: "error",
        message: "Сессия истекла. Откройте приложение заново из Telegram.",
      });
    };
    const timer = window.setTimeout(
      expire,
      Math.max(0, Date.parse(state.session.expiresAt) - Date.now()),
    );
    const check = () => {
      if (Date.parse(state.session.expiresAt) <= Date.now()) expire();
    };
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [state]);
  const logout = async () => {
    if (state.status !== "authenticated") return;
    const session = state.session;
    setState({ status: "loading" });
    try {
      await request<{ ok: true }>("session", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.token}` },
      });
      clearUserLocalState(session.user.id);
      currentSession = null;
      setState({ status: "signed-out" });
    } catch {
      clearUserLocalState(session.user.id);
      currentSession = null;
      setState({
        status: "error",
        message:
          "Не удалось подтвердить выход на сервере. Сессия автоматически истечёт через 24 часа.",
      });
    }
  };
  return {
    state,
    retry: () => {
      currentSession = null;
      setAttempt((value) => value + 1);
    },
    logout,
  };
}
