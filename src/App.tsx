import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import { Events } from "./Events";
import { Logo } from "./visual";

export function App() {
  const { state, retry, logout } = useAuth();
  const [dataReady, setDataReady] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const ready = state.status === "authenticated" && dataReady;
  useEffect(() => {
    if (state.status === "authenticated") return;
    setShowSplash(true);
    setDataReady(false);
  }, [state.status]);
  useEffect(() => {
    if (!ready) return;
    const timeout = window.setTimeout(() => setShowSplash(false), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 520);
    return () => window.clearTimeout(timeout);
  }, [ready]);
  return <>
    {state.status === "authenticated" && <Events token={state.session.token} userId={state.session.user.id} displayName={state.session.user.displayName} logout={logout} onReady={() => setDataReady(true)} />}
    {showSplash && <div className={`splash ${ready ? "splash--leaving" : ""}`} role="status" aria-live="polite">
      <Logo className="splash-logo" />
      {state.status !== "loading" && state.status !== "authenticated" && <div className="splash-message">
        <strong>{state.status === "outside" ? "Откройте раскидай в Telegram" : state.status === "unconfigured" ? "Приложение пока не подключено" : state.status === "signed-out" ? "Вы вышли из аккаунта" : "Не удалось войти"}</strong>
        <p>{state.status === "error" ? state.message : state.status === "outside" ? "Запустите Mini App через бота." : state.status === "signed-out" ? "Войдите снова через Telegram." : "Попробуйте позже."}</p>
        {(state.status === "error" || state.status === "signed-out") && <button onClick={retry}>Повторить</button>}
      </div>}
    </div>}
  </>;
}
