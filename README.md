# Раскидай

Telegram Mini App для разделения расходов на мероприятия до 30 участников.

## Текущий этап

Подготовлен каркас React + TypeScript + Vite, стартовый адаптивный экран,
проверка типов, сборка, CI и ручной workflow публикации на GitHub Pages.
Supabase инициализирован для дальнейшей разработки Edge Functions и миграций.
Авторизация, мероприятия, расходы и расчёты пока не реализованы.
Стартовый экран не выдаёт демонстрационные данные за реальные.

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
pnpm typecheck
pnpm build
pnpm preview
```

Production preview: http://localhost:4173/raskidai_tg_app/.
Для этапа 1 переменные окружения и Telegram не нужны.

## Структура

- `src/` — интерфейс Mini App.
- `supabase/functions/` — будущая серверная логика на TypeScript/Deno.
- `supabase/migrations/` — будущие версионированные SQL-миграции.
- `supabase/config.toml` — конфигурация локального Supabase.
- `docs/PLAN.md` — согласованные правила, архитектура и этапы.
- `.github/workflows/` — проверка сборки и публикация.

## Окружение и секреты

При подключении backend скопируйте `.env.example` в `.env.local`.
Всё с префиксом `VITE_` попадает в общедоступный браузерный код.
Токен бота и Supabase secret/service-role key хранятся только в секретах
Edge Functions; локально — в игнорируемом `supabase/.env`.
На этом этапе реальные секреты не нужны и подключения к облачной БД нет.

Для локального Supabase нужен запущенный Docker:

```sh
pnpm exec supabase start
pnpm exec supabase status
pnpm exec supabase stop
```

Миграции добавляем вместе с функциями на следующих этапах. Схема запланирована
в `docs/PLAN.md`; пустые каталоги не означают готовую базу данных.

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
