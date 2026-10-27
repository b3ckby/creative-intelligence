# Creative Intelligence MVP Application Slice Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Превратить проверенный PostgreSQL/RBAC/REST-фундамент в первый пригодный для интерфейса end-to-end API-контур: Ad Library → Brief → Iteration Map, с production bootstrap, OIDC-аутентификацией и постоянно запускаемыми тестами на реальном PostgreSQL.

**Architecture:** Сохраняем provider-neutral домен и forced RLS. HTTP остаётся тонким слоем над сервисами и PostgreSQL repositories. Идентичность пользователя поступает через отдельный OIDC/JWKS-адаптер, а `app.user_id` устанавливается только внутри транзакции. Реальный Meta-провайдер и полноценный UI откладываются до стабилизации этого API-контракта.

**Tech Stack:** TypeScript, Node.js, Fastify, PostgreSQL 18, `pg`, Node test runner, JSON Schema/OpenAPI, OIDC/JWT/JWKS.

---

## Current context and gates

- Готовы и проверены: домен, provider boundary, PostgreSQL schema, forced RLS, организации/роли, manual Meta import, базовый REST API.
- Текущий статус: 37/37 тестов, typecheck и audit проходят; независимый fail-closed review прошёл.
- Код ещё не закоммичен и не развёрнут.
- **Commit gate:** до отдельного разрешения пользователя не создавать commit, tag или remote push. Шаги commit ниже являются контрольными точками, а не разрешением выполнить их.
- **Deployment gate:** не разворачивать приложение до выбора OIDC issuer/audience и production connection settings.

## Recommended sequence

### Task 1: Зафиксировать воспроизводимый PostgreSQL integration harness

**Objective:** Сделать реальные PostgreSQL-проверки частью стандартной команды, а не ручными probes.

**Files:**
- Create: `tests/postgres/helpers/real-postgres.ts`
- Create: `tests/postgres/rls.integration.test.ts`
- Create: `tests/postgres/manual-import.integration.test.ts`
- Create: `tests/postgres/final-admin.integration.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Steps:**
1. Написать failing integration tests для migration apply/cleanup, missing-context denial, tenant isolation, final-admin concurrency, organization cascade и exact-ID/concurrent import.
2. Использовать отдельную временную БД и временные роли с уникальным суффиксом; cleanup выполнять в `finally`.
3. Запретить запуск против произвольной production database; принимать только локальный явно заданный integration DSN или provisioner DSN.
4. Добавить команды `test:unit`, `test:postgres`, `check`.
5. Проверить, что `npm run test:postgres` проходит на PostgreSQL 18 и не оставляет БД/ролей.
6. Контрольная точка commit: `test: add real PostgreSQL security integration suite` — только после разрешения пользователя.

**Acceptance:** все критические свойства, которые раньше проверялись вручную, воспроизводятся одной командой.

### Task 2: Завершить PostgreSQL persistence для Briefs и Iteration Map

**Objective:** Убрать разрыв между готовым in-memory доменом и production PostgreSQL.

**Files:**
- Create: `src/persistence/postgres-brief-repository.ts`
- Create: `src/persistence/postgres-iteration-map-repository.ts`
- Modify: `src/briefs/brief-service.ts`
- Modify: `src/iteration-map/iteration-map-service.ts`
- Create: `tests/postgres-briefs.test.ts`
- Create: `tests/postgres-iteration-map.test.ts`

**Steps:**
1. Сначала написать failing tests на создание/чтение briefs в рамках tenant.
2. Реализовать parameterized queries через verified transaction-local context.
3. Написать failing tests на cross-tenant denial и чужие product/ad IDs.
4. Реализовать lookup через composite ownership constraints и tenant-scoped joins.
5. Написать failing tests Iteration Map для covered/missing combinations и лимита 10 000.
6. Реализовать выборку данных и передавать расчёт существующему доменному сервису, не дублируя алгоритм в SQL.
7. Запустить unit + real PostgreSQL suites.
8. Контрольная точка commit: `feat: persist briefs and iteration maps in PostgreSQL` — только после разрешения.

**Acceptance:** Brief и Iteration Map работают на PostgreSQL с теми же tenant-инвариантами, что и остальные сущности.

### Task 3: Завершить API-контракт первого продуктового контура

**Objective:** Дать будущему UI полный API для Product → Competitor → Ads → Brief → Iteration Map.

**Files:**
- Modify: `src/http/build-api.ts`
- Create: `src/http/schemas.ts`
- Create: `tests/rest-catalog.test.ts`
- Create: `tests/rest-briefs.test.ts`
- Create: `tests/rest-iteration-map.test.ts`

**Endpoints:**
- `GET /organizations/:organizationId/products`
- `GET /organizations/:organizationId/products/:productId/competitors`
- `GET /organizations/:organizationId/ads` с bounded filters/pagination
- `GET /organizations/:organizationId/ads/:adId`
- `POST /organizations/:organizationId/briefs`
- `GET /organizations/:organizationId/briefs`
- `GET /organizations/:organizationId/briefs/:briefId`
- `GET /organizations/:organizationId/iteration-map`

**Steps:**
1. Описать request/response JSON Schemas и единый bounded pagination contract.
2. Написать failing REST tests для happy path, 400/401/403/404/409/413/415 и cross-tenant cases.
3. Реализовать handlers без бизнес-логики внутри HTTP слоя.
4. Не возвращать internal SQL/provider/auth details.
5. Добавить deterministic ordering для списков.
6. Проверить malformed JSON, unknown route/method и unsupported media type.
7. Контрольная точка commit: `feat: expose complete MVP workflow API` — только после разрешения.

**Acceptance:** весь первый пользовательский сценарий доступен через стабильный tenant-safe REST API.

### Task 4: Добавить provider-neutral production authentication

**Objective:** Заменить только тестовую injected-auth схему на production OIDC/JWKS adapter без привязки к одному поставщику.

**Files:**
- Create: `src/auth/authenticator.ts`
- Create: `src/auth/oidc-jwks-authenticator.ts`
- Create: `src/config/runtime-config.ts`
- Modify: `src/http/build-api.ts`
- Create: `tests/oidc-auth.test.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Steps:**
1. Согласовать перед реализацией `issuer`, `audience` и claim, который является стабильным user ID; секреты в репозиторий не добавлять.
2. Написать failing tests на valid token, expired token, wrong issuer/audience, missing subject, key rotation и недоступный JWKS.
3. Реализовать интерфейс `Authenticator` и OIDC/JWKS adapter с fail-closed cache behavior.
4. Передавать в repositories только проверенный стабильный subject.
5. Оставить test authenticator только в test composition root; production bootstrap не должен иметь permissive default.
6. Контрольная точка commit: `feat: add fail-closed OIDC authentication` — только после разрешения.

**Acceptance:** сервер не стартует без валидной auth-конфигурации и не принимает неподписанную/неподходящую identity.

### Task 5: Создать production bootstrap и operational endpoints

**Objective:** Сделать API реально запускаемым и наблюдаемым без ослабления security model.

**Files:**
- Create: `src/server.ts`
- Create: `src/app.ts`
- Create: `src/persistence/postgres-pool.ts`
- Create: `tests/server-startup.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Steps:**
1. Написать failing startup tests на отсутствующую конфигурацию, runtime DB role mismatch и недоступную БД.
2. Реализовать strict config parsing и redacted startup errors.
3. Добавить `/health/live` без DB-доступа и `/health/ready` с bounded DB probe.
4. Проверять при startup, что session user не `SUPERUSER` и не `BYPASSRLS`, а runtime role ожидаемая.
5. Реализовать graceful shutdown HTTP server и pool.
6. Запустить весь `npm run check` и PostgreSQL integration suite.
7. Контрольная точка commit: `feat: add secure production server bootstrap` — только после разрешения.

**Acceptance:** приложение запускается одной документированной командой, readiness отражает реальное состояние БД, unsafe DB role отклоняется.

### Task 6: Формализовать API и провести независимый review

**Objective:** Зафиксировать контракт перед созданием интерфейса.

**Files:**
- Create: `docs/openapi.json` или генерируемый эквивалент
- Create: `docs/API.md`
- Modify: `README.md`

**Steps:**
1. Генерировать OpenAPI из тех же schemas, которые валидирует Fastify.
2. Проверить, что документация не содержит credentials, внутренних SQL details и приватных URL.
3. Запустить typecheck, unit tests, real PostgreSQL tests, audit и diff check.
4. Провести независимый fail-closed review tenant/auth/import/error boundaries.
5. Исправлять findings через RED → GREEN; одобрение возможно только при нулевых security concerns и logic errors.
6. Контрольная точка commit: `docs: publish MVP API contract` — только после разрешения.

**Acceptance:** API-контракт стабилен и готов для frontend-разработки.

## Following roadmap

После завершения этого плана:

1. **Frontend MVP:** отдельное выразительное светлое рабочее пространство без типового тёмного AI-дизайна: Products, Competitors, Ad Library, Brief Builder, Iteration Map.
2. **Первый реальный Meta adapter:** отдельный `ApifyMetaAdsProvider` или другой выбранный источник; credentials только через secret storage, provider output остаётся недоверенным.
3. **Media intelligence:** загрузка/нормализация preview assets, OCR/transcription, creative tags и similarity clusters.
4. **Collaboration:** комментарии, статусы briefs, audit log.
5. **Deployment:** staging, backups, migrations, observability, rate limits и restore drill.

## Risks and open decisions

- Нужен выбор OIDC-провайдера или как минимум точные `issuer`, `audience`, stable user-ID claim.
- Нужен отдельный provisioning DSN для migrations; приложение никогда не должно подключаться provisioning role.
- Перед первым commit желательно отдельно подтвердить создание baseline commit всего уже проверенного слоя.
- До подключения реального Meta provider нужно выбрать источник и проверить его условия использования, стоимость и допустимость хранения creatives.

## Final verification commands

```bash
npm run typecheck
npm run test:unit
npm run test:postgres
npm audit --audit-level=low
git diff --check
```

Expected: все команды завершаются с exit code 0; временные PostgreSQL БД и роли удалены; independent review возвращает `passed: true` с пустыми `security_concerns` и `logic_errors`.
