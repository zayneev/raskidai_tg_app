# Этап 2: подключение Telegram и Supabase

Этап 2 завершён 08.09.2026: пользователь подтвердил реальный вход через Telegram,
миграция и серверные проверки выполнены. Секреты не отправляйте в чат,
не добавляйте в Git, VITE-переменные или GitHub Pages.

## Бот

1. В официальном @BotFather создать бота командой `/newbot`, если его ещё нет.
2. В `/mybots` выбрать бота → Bot Settings → Configure Mini App и включить
   Main Mini App с URL `https://zayneev.github.io/raskidai_tg_app/`.
3. Настроить Menu Button на тот же URL через BotFather (`/setmenubutton`).
   Название кнопки: «Открыть Раскидай».
4. Сохранить токен бота в серверном секрете `TELEGRAM_BOT_TOKEN`.

Открывать приложение через профиль/меню бота, а не обычную браузерную ссылку.
Бот не требует polling или webhook для этого сценария.

## Облачный backend

Создать проект Supabase, затем из корня репозитория:

```sh
pnpm exec supabase login
pnpm exec supabase link --project-ref YOUR_PROJECT_REF
pnpm exec supabase db push
```

В Supabase → Edge Functions → Secrets добавить:

- `TELEGRAM_BOT_TOKEN` — токен этого бота.
- `ALLOWED_ORIGINS` — `https://zayneev.github.io` (без завершающего слеша и пути).

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` предоставляет серверный runtime.
Затем опубликовать функции:

```sh
pnpm exec supabase functions deploy telegram-auth
pnpm exec supabase functions deploy session
```

В config.toml для обеих функций задано `verify_jwt = false`: используется
собственная сессия, а не Supabase Auth JWT. Проверки внутри обработчиков обязательны.
Отключение gateway JWT не открывает таблицы: у anon/authenticated отозваны права,
RLS включён без разрешающих политик, RPC доступны только service_role.

В GitHub → Settings → Secrets and variables → Actions → Variables добавить
`VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co`.
Запустить Publish GitHub Pages после отправки проверенного кода.

## Локальная проверка

Нужны Docker и Deno 2 (последний — для проверки runtime-типов).

```sh
cp .env.example .env.local
cp supabase/.env.example supabase/.env
# Заполнить VITE_SUPABASE_URL=http://127.0.0.1:54321 и серверный токен бота.
pnpm exec supabase start
pnpm exec supabase migration up
pnpm exec supabase test db
pnpm exec supabase functions serve --env-file supabase/.env
# В другом терминале:
pnpm dev
```

Обычный браузер покажет приглашение открыть Telegram. Для входа из Telegram
локальный frontend/backend должны быть доступны устройству по HTTPS; их origin
нужно добавить в ALLOWED_ORIGINS. Проще проверить вход на облачном стенде.
Поддельного режима входа и генератора initData в приложении нет.

```sh
pnpm test
pnpm build
deno check supabase/functions/telegram-auth/index.ts supabase/functions/session/index.ts
```

## Контракт и ограничения

- `POST /functions/v1/telegram-auth`, JSON `{ "initData": "..." }`:
  ответ `{ token, user: { id, displayName }, expiresAt }`.
- `GET /functions/v1/session`, заголовок `Authorization: Bearer <token>`:
  ответ `{ user: { id, displayName }, expiresAt }`. Пользователь берётся из БД.
- `DELETE /functions/v1/session` с тем же заголовком отзывает текущую сессию.
- Проверка HMAC-SHA-256 включает все поля кроме hash; сравнение выполняет Web Crypto.
  Допустимый возраст initData — 5 минут, отклонение часов в будущее — 30 секунд.
- Сессия — 32 случайных байта, действует 24 часа без продления. В БД только SHA-256.
  Frontend хранит токен в памяти, при перезагрузке повторяет Telegram-вход.
  При устаревшем initData нужно закрыть и снова открыть Mini App.
- Повторный обмен действующего initData допустим в пределах 5 минут: это bearer
  credential, его нельзя логировать или передавать третьим лицам. Выход отзывает
  конкретную сессию, а не исходное initData или сессии на других устройствах.
- Старые сессии пользователя очищаются при следующем входе. Для пилота с большим
  потоком понадобится регулярная очистка и ограничение частоты входа.
- Следующие Edge Functions должны определять пользователя по активной сессии.
  В транзакциях этапов 3+ повторно проверять сессию и права внутри RPC.

## Приёмка на стенде

1. Запустить SQL-тесты: запрет доступа клиентских ролей, повторный вход без дубля
   пользователя, истечение и отзыв сессии.
2. Открыть Mini App реальным аккаунтом: отображается имя из подтверждённой сессии.
3. Повторить вход: в users остаётся одна строка для Telegram ID.
4. Изменить initData / использовать данные старше 5 минут: HTTP 401, сессия не создана.
5. GET session без токена/с выдуманным токеном: HTTP 401.
6. Выйти: старый токен больше не принимается. Открыть вторым аккаунтом:
   получен другой внутренний ID пользователя.
7. Проверить обычный браузер, отсутствие backend-конфигурации и сетевую ошибку.

Не сохранять initData и токены в скриншотах/логах приёмки.

Источники: [Telegram Mini Apps](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app),
[Supabase Edge Functions](https://supabase.com/docs/guides/functions/auth).

## Подключённый стенд

- Бот: `@raskidai_app_bot`.
- Организация: `raskidai` (`lfhpncgfgyrjlnelfsla`), Free.
- Проект: `raskidai` (`njzfzgqprgkyrqirkvhe`), Frankfurt (`eu-central-1`).
- API URL: `https://njzfzgqprgkyrqirkvhe.supabase.co`.
- Миграция Telegram auth применена; обе Edge Functions опубликованы.
- На облачной БД проверены запрет клиентского доступа, повторный вход,
  истечение и отзыв сессии. Тестовая транзакция откатана.
- TELEGRAM_BOT_TOKEN и ALLOWED_ORIGINS добавлены пользователем в Edge Functions Secrets.
- GitHub Pages опубликован; workflow использует URL проекта по умолчанию,
  переменная VITE_SUPABASE_URL позволяет переопределить его.
- CI, SQL-тесты, Deno check и deployment прошли.
- Реальный вход через Telegram подтверждён пользователем 08.09.2026.

## Дополнение этапа 3 (09.09.2026)

В том же проекте применена миграция events и опубликована Edge Function events.
Секреты и реальный вход этапа 2 сохранены. Новые секреты не нужны.
Для развёртывания всех функций из локального кода дополнительно выполнить
`pnpm exec supabase functions deploy events`.
Приглашения используют Main Mini App бота; сценарий проверки после публикации
frontend описан в [EVENTS.md](EVENTS.md).
