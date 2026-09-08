import { useState } from "react";
import { useAuth } from "./auth";

export function App() {
  const { state, retry, logout } = useAuth();
  const [showDetails, setShowDetails] = useState(false);

  return (
    <main className="app">
      <header className="header">
        <a className="brand" href="#" aria-label="Раскидай — главная">
          <span className="brand-icon" aria-hidden="true">
            ↗
          </span>
          раскидай
        </a>
        <span className="badge">Telegram Mini App</span>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">ВМЕСТЕ ОТДЫХАТЬ. ЛЕГКО СЧИТАТЬ.</p>
        <h1 id="hero-title">
          Впечатления общие.
          <br />
          <span>Расходы — поровну.</span>
        </h1>
        <p className="intro">
          Поездка, ужин или выходные с друзьями. Соберите расходы в одном месте,
          а Раскидай подскажет, кто кому сколько переводит.
        </p>

        <div className="illustration" aria-hidden="true">
          <span className="bubble bubble-one">Ужин 🍝</span>
          <span className="bubble bubble-two">Такси 🚕</span>
          <div className="receipt">
            <span className="receipt-label">ХОРОШО ПОСИДЕЛИ</span>
            <strong>
              Всё поделим<span>по-дружески</span>
            </strong>
            <div className="receipt-line" />
            <div className="avatars">
              <i>А</i>
              <i>Б</i>
              <i>В</i>
              <i>Г</i>
            </div>
            <span className="receipt-footer">Каждому — своя доля</span>
          </div>
          <span className="bubble bubble-three">Домик 🏡</span>
        </div>

        <div className="notice" role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          <div>
            {state.status === "loading" && <strong>Проверяем вход…</strong>}
            {state.status === "outside" && (
              <>
                <strong>Откройте Раскидай в Telegram</strong>
                <p>
                  Для входа запустите мини-приложение через кнопку в профиле или
                  меню бота.
                </p>
              </>
            )}
            {state.status === "unconfigured" && (
              <>
                <strong>Вход скоро появится</strong>
                <p>Подключаем сервер. Попробуйте открыть приложение позже.</p>
              </>
            )}
            {state.status === "authenticated" && (
              <>
                <strong>Привет, {state.session.user.displayName}!</strong>
                <p>
                  Вход через Telegram подтверждён. Создание мероприятий появится
                  на следующем этапе.
                </p>
                <button className="auth-button" onClick={() => void logout()}>
                  Выйти
                </button>
              </>
            )}
            {state.status === "error" && (
              <>
                <strong>Не удалось войти</strong>
                <p>{state.message}</p>
                <button className="auth-button" onClick={retry}>
                  Повторить
                </button>
              </>
            )}
            {state.status === "signed-out" && (
              <>
                <strong>Вы вышли</strong>
                <p>Сессия завершена.</p>
                <button className="auth-button" onClick={retry}>
                  Войти через Telegram
                </button>
              </>
            )}
          </div>
        </div>
        <button
          className="details-button"
          onClick={() => setShowDetails(!showDetails)}
          aria-expanded={showDetails}
          aria-controls="how-it-works"
        >
          Как это будет работать{" "}
          <span aria-hidden="true">{showDetails ? "−" : "+"}</span>
        </button>
        {showDetails && (
          <ol id="how-it-works" className="steps">
            <li>
              <strong>Соберите компанию</strong>
              <span>Создайте мероприятие и отправьте ссылку друзьям.</span>
            </li>
            <li>
              <strong>Запишите расходы</strong>
              <span>
                Каждый добавляет свои покупки и выбирает, на кого их разделить.
              </span>
            </li>
            <li>
              <strong>Нажмите «Раскидать»</strong>
              <span>Получите список переводов и отметьте взаиморасчёты.</span>
            </li>
          </ol>
        )}
      </section>
      <footer>Меньше подсчётов. Больше хороших встреч.</footer>
    </main>
  );
}
