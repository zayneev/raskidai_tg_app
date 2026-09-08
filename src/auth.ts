import { useEffect, useState } from "react";

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
async function request(path: string, init: RequestInit) {
  const response = await fetch(`${baseUrl}/functions/v1/${path}`, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (response.status === 401)
      throw new Error(
        "Данные входа истекли или не прошли проверку. Закройте приложение и откройте его заново из Telegram.",
      );
    throw new Error("Не удалось связаться с сервером. Попробуйте ещё раз.");
  }
  return response.json();
}
function login(initData: string): Promise<Session> {
  if (!pending) {
    pending = request("telegram-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    })
      .then(async (session: Session) => {
        // Confirm the issued session through the protected endpoint.
        const verified = await request("session", {
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
      await request("session", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.token}` },
      });
      currentSession = null;
      setState({ status: "signed-out" });
    } catch {
      currentSession = null;
      setState({
        status: "error",
        message:
          "Не удалось подтвердить выход на сервере. Сессия автоматически истечёт через 24 часа.",
      });
    }
  };
  return { state, retry: () => setAttempt((value) => value + 1), logout };
}
