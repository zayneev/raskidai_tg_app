# Раскидай

Telegram Mini App для разделения расходов на мероприятия до 30 участников.

## Текущий этап

Этап 1 выполнен. Для этапа 2 реализованы Telegram-вход, проверка подписи и
свежести initData, серверные сессии, таблица users и запрет прямого доступа к БД.
Есть состояния входа, ошибки, повторной попытки и выхода. Мероприятия, расходы
и расчёты пока не реализованы.

Подключение бота, deployment и приёмка реального входа описаны в
[docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md). До проверки на стенде этап 2
не считается завершённым.

## Локальный запуск

Нужны Node.js 22.14+ (или совместимый 22.x) и pnpm 11.19.0.

```sh
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

Открыть http://localhost:5173/raskidai_tg_app/.
Если в установленном Node.js нет Corepack, установите pnpm по https://pnpm.io/installation.

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm preview
```

Production preview: http://localhost:4173/raskidai_tg_app/.
Для просмотра стартового экрана переменные окружения и Telegram не нужны.
Для входа нужен настроенный backend и запуск через Telegram.

## Структура

- `src/` — интерфейс Mini App.
- `supabase/functions/` — серверная логика входа и сессий на TypeScript/Deno.
- `supabase/migrations/` — версионированные SQL-миграции.
- `supabase/config.toml` — конфигурация локального Supabase.
- `docs/PLAN.md` — согласованные правила, архитектура и этапы.
- `.github/workflows/` — проверка сборки и публикация.

## Окружение и секреты

При подключении backend скопируйте `.env.example` в `.env.local`.
Всё с префиксом `VITE_` попадает в общедоступный браузерный код.
Токен бота и Supabase secret/service-role key хранятся только в секретах
Edge Functions; локально — в игнорируемом `supabase/.env`.
Для проверки реального входа нужны серверный токен бота и подключённый Supabase.

Для локального Supabase нужен запущенный Docker:

```sh
pnpm exec supabase start
pnpm exec supabase status
pnpm exec supabase stop
```

Первая миграция создаёт users, app_sessions и серверные RPC.
После запуска Supabase примените её через `pnpm exec supabase migration up`,
затем выполните `pnpm exec supabase test db`. Остальные сущности добавляются
по этапам из `docs/PLAN.md`.

## Публикация

1. Отправить проверенный код в `main` репозитория `zayneev/raskidai_tg_app`.
2. В GitHub: Settings → Pages → Source → GitHub Actions.
3. Actions → Publish GitHub Pages → Run workflow → main.
4. Проверить успешное завершение workflow и адрес
   https://zayneev.github.io/raskidai_tg_app/.

Публикация запускается вручную, CI — на push в main и pull request.
`base` в Vite соответствует имени репозитория. Пока используется один экран,
дальнейшую навигацию реализуем через hash, чтобы обновление страницы не давало 404.
Параметр приглашения Telegram `startapp` обрабатывается отдельно на этапе 3.

## Источники

- https://vite.dev/guide/static-deploy#github-pages
- https://supabase.com/docs/guides/local-development
- https://core.telegram.org/bots/webapps
