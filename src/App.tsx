import { useState } from "react";

export function App() {
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
        <span className="badge">Скоро в Telegram</span>
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

        <div className="notice">
          <span className="dot" aria-hidden="true" />
          <div>
            <strong>Готовим первое мероприятие</strong>
            <p>
              Приложение в разработке. Создание мероприятий появится чуть позже.
            </p>
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
