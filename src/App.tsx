import { useEffect, useRef, useState } from "react";
import { AnimatePresence, useAnimate, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useAuth } from "./auth";
import { Events } from "./Events";
import { Logo } from "./visual";

export function App() {
  const { state, retry, logout } = useAuth();
  const [dataReady, setDataReady] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const splashStartedAt = useRef(performance.now());
  const [splashScope, animate] = useAnimate();
  const reducedMotion = useReducedMotion();
  const ready = state.status === "authenticated" && dataReady;

  useEffect(() => {
    if (state.status === "authenticated") return;
    setShowSplash(true);
    setDataReady(false);
    splashStartedAt.current = performance.now();
  }, [state.status]);

  useEffect(() => {
    if (reducedMotion || !showSplash) return;
    const controls = animate(
      [
        ["#breve-left", { opacity: [1, 0.16, 1] }, { duration: 1.3 }],
        ["#breve-right", { opacity: [1, 0.16, 1] }, { duration: 1.3 }],
      ],
      { repeat: Infinity, repeatDelay: 0.6 },
    );
    return () => controls.stop();
  }, [animate, reducedMotion, showSplash]);

  useEffect(() => {
    if (!ready) return;
    const wait = reducedMotion
      ? 0
      : Math.max(0, 1000 - (performance.now() - splashStartedAt.current));
    const timeout = window.setTimeout(() => setShowSplash(false), wait);
    return () => window.clearTimeout(timeout);
  }, [ready, reducedMotion]);

  return (
    <>
      {state.status === "authenticated" && (
        <Events
          token={state.session.token}
          userId={state.session.user.id}
          displayName={state.session.user.displayName}
          logout={logout}
          onReady={() => setDataReady(true)}
        />
      )}
      <AnimatePresence>
        {showSplash && (
          <m.div
            ref={splashScope}
            className="splash"
            role="status"
            aria-live="polite"
            initial={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: "-100%" }}
            transition={{
              duration: reducedMotion ? 0.18 : 0.6,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <Logo className="splash-logo" />
            {state.status !== "loading" && state.status !== "authenticated" && (
              <div className="splash-message">
                <strong>
                  {state.status === "outside"
                    ? "Откройте раскидай в Telegram"
                    : state.status === "unconfigured"
                      ? "Приложение пока не подключено"
                      : state.status === "signed-out"
                        ? "Вы вышли из аккаунта"
                        : "Не удалось войти"}
                </strong>
                <p>
                  {state.status === "error"
                    ? state.message
                    : state.status === "outside"
                      ? "Запустите Mini App через бота."
                      : state.status === "signed-out"
                        ? "Войдите снова через Telegram."
                        : "Попробуйте позже."}
                </p>
                {(state.status === "error" ||
                  state.status === "signed-out") && (
                  <button onClick={retry}>Повторить</button>
                )}
              </div>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </>
  );
}
