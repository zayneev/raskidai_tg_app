import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";
import { Events } from "./Events";
import { Logo } from "./visual";

export function App() {
  const { state, retry, logout } = useAuth();
  const [dataReady, setDataReady] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [splashLeaving, setSplashLeaving] = useState(false);
  const splashStartedAt = useRef(performance.now());
  const ready = state.status === "authenticated" && dataReady;
  useEffect(() => {
    if (state.status === "authenticated") return;
    setShowSplash(true);
    setSplashLeaving(false);
    setDataReady(false);
    splashStartedAt.current = performance.now();
  }, [state.status]);
  useEffect(() => {
    if (!ready) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = reducedMotion ? 0 : Math.max(0, 750 - (performance.now() - splashStartedAt.current));
    const timeout = window.setTimeout(() => setSplashLeaving(true), wait);
    return () => window.clearTimeout(timeout);
  }, [ready]);
  useEffect(() => {
    if (!splashLeaving) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timeout = window.setTimeout(() => setShowSplash(false), reducedMotion ? 0 : 650);
    return () => window.clearTimeout(timeout);
  }, [splashLeaving]);
  return <>
    {state.status === "authenticated" && <Events token={state.session.token} userId={state.session.user.id} displayName={state.session.user.displayName} logout={logout} onReady={() => setDataReady(true)} />}
    {showSplash && <div className={`splash ${ready && splashLeaving ? "splash--leaving" : ""}`} role="status" aria-live="polite">
      <Logo className="splash-logo" />
      {state.status !== "loading" && state.status !== "authenticated" && <div className="splash-message">
        <strong>{state.status === "outside" ? "Откройте раскидай в Telegram" : state.status === "unconfigured" ? "Приложение пока не подключено" : state.status === "signed-out" ? "Вы вышли из аккаунта" : "Не удалось войти"}</strong>
        <p>{state.status === "error" ? state.message : state.status === "outside" ? "Запустите Mini App через бота." : state.status === "signed-out" ? "Войдите снова через Telegram." : "Попробуйте позже."}</p>
        {(state.status === "error" || state.status === "signed-out") && <button onClick={retry}>Повторить</button>}
      </div>}
    </div>}
  </>;
}
