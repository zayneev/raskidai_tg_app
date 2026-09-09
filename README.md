# Раскидай

Telegram Mini App для разделения расходов на мероприятия до 30 участников.

## Текущий этап

Этапы 1–3 завершены. Frontend опубликован; приглашение и выход проверены
пользователем двумя Telegram-аккаунтами 09.09.2026.

Реализован этап 4: создание, список, редактирование и удаление расходов,
равные доли в целых копейках, права автора/создателя, история и защита от повторов.
Backend опубликован в существующем проекте Supabase. Проверки и статус
публикации frontend: [docs/EXPENSES.md](docs/EXPENSES.md).
Расчёты и переводы — следующие этапы.

Подключение бота и вход: [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md).
Контракт мероприятий: [docs/EVENTS.md](docs/EVENTS.md).

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

Миграции создают users, app_sessions, events, members, invitations, expenses,
expense_shares, expense_requests, audit_log и серверные RPC.
После запуска Supabase примените их через `pnpm exec supabase migration up`,
затем выполните `pnpm exec supabase test db`. Остальные сущности добавляются
по этапам из `docs/PLAN.md`.

## Публикация

1. Отправить проверенный код в `main` репозитория `zayneev/raskidai_tg_app`.
2. В GitHub: Settings → Pages → Source → GitHub Actions.
3. Actions → Publish GitHub Pages → Run workflow → main.
4. Проверить успешное завершение workflow и адрес
   https://zayneev.github.io/raskidai_tg_app/.

Публикация запускается вручную, CI — на push в main и pull request.
`base` в Vite соответствует имени репозитория. Навигация мероприятий использует
hash, чтобы обновление страницы не давало 404. Приглашения Telegram `startapp`
обрабатываются после входа.

## Источники

- https://vite.dev/guide/static-deploy#github-pages
- https://supabase.com/docs/guides/local-development
- https://core.telegram.org/bots/webapps
