# SensoLab Community — App completa (diseño de ejecución)

Fecha: 2026-09-08
Estado: aprobado para construir ("dale con todo")

## Decisión de stack

Se **termina el backend Node + Express + `node:sqlite`** y la PWA de un solo
archivo (`index.html`) que ya existen y funcionan. No se reescribe a FastAPI /
Next.js 14: contradice el propio spec ("horas-días", "stack ya dominado") y
tiraría un prototipo funcional. El esquema del spec mapea a SQLite; Postgres
sigue siendo un cambio aislado en `db.js` más adelante.

## Reconciliación de nombres

El spec usa `sessions_catalog` / `session_attempts` / `points_ledger`. El repo ya
tiene `session_catalog` / `user_sessions`. Se **conservan los nombres del repo**
(no romper el código ni la feature remota) y se **añade** `points_ledger` como
fuente de verdad, más las tablas nuevas. `user_sessions` == `session_attempts`.

## Modelo de datos (cambios sobre lo existente)

Nuevas tablas:

- `level_tiers(level PK, name, min_points)` — reemplaza `LEVELS` hardcodeado.
- `points_ledger(id, user_id, delta, reason, ref_type, ref_id, created_at)` —
  **fuente de verdad**. `users.points` es cache: se recalcula sumando el ledger.
- `user_sensory_profile(user_id PK, dob, country, city, dietary_restrictions,
  allergies, sensory_prefs_json, smoker, notes, completed_at)`.
- `auth_otps(id, email, code, purpose, expires_at, consumed, created_at)` — OTP
  de registro/login. En dev el código se devuelve en la respuesta.
- `consents(user_id, kind, granted_at)`.

Columnas añadidas (vía `ALTER TABLE … ADD COLUMN` defensivo, migra in-place):

- `users`: `phone`, `avatar_seed`, `status` ('pending'|'active'), `country`,
  `city`, `onboarded_at`, `consent_at`.
- `session_catalog`: `duration_sec`, `min_duration_sec`,
  `prerequisite_session_id`, `sensory_tags` (csv), `repeatable`.
- `user_sessions`: `respuestas_json`, `sospechoso`, `idempotency_key`.
- `preferences`: `reminder_hour` (default '19:00').
- `notifications`: `tipo` (default 'system').

Regla dura: nunca se hace `UPDATE users SET points = points + N`. Se inserta en
`points_ledger` y se llama `recomputeUserPoints()`. Si cache y ledger divergen,
gana el ledger.

## Módulos backend nuevos

| archivo | responsabilidad |
|---|---|
| `ledger.js` | `addLedger()`, `recomputeUserPoints()`, `weeklyDelta()` |
| `badges.js` | `evaluateBadges()` — criterio racha/nivel/sesiones_count → otorga + notifica + fila de ledger |
| `otp.js` | `issueOtp()`, `verifyOtp()` |

`gamification.js` pasa a leer `level_tiers` de la BD (fallback a constante).

## Endpoints (además de los que ya existen y siguen vivos)

| método | ruta | nota |
|---|---|---|
| POST | `/api/auth/register` | `{nombre, email, phone?}` → user `status='pending'`. Email duplicado → `{mode:'login'}`, sin fricción. |
| POST | `/api/auth/request-otp` | `{email}` → emite OTP (código en dev). |
| POST | `/api/auth/verify-otp` | `{email, code}` → activa user, devuelve `{token, user}`. |
| GET | `/api/onboarding/status` | `{registered, verified, sensoryProfile, consent, done}` — el cliente enruta con esto. |
| GET/PUT | `/api/me/sensory-profile` | cuestionario "de dónde eres" + restricciones. PUT marca `completed_at` y copia country/city a `users`. |
| POST | `/api/me/consent` | `{kind}` → registra consentimiento. |
| GET | `/api/me/summary` | home en una sola llamada: puntos, nivel, delta semanal, sesiones, actividad. |
| GET | `/api/me/badges` | insignias + progreso. |

Cambios en endpoints existentes:

- `GET /api/sessions` — elegibilidad server-side ahora también: prerequisito
  cumplido + `sensory_tags` no chocan con alergias/restricciones del perfil. El
  chip `locked` es reflejo, no la regla.
- `POST /api/sessions/:slug/start` — graba `started_at` server-side, devuelve
  `startedAt` y `minDurationSec`.
- `POST /api/sessions/:slug/complete` — idempotency key (header `Idempotency-Key`
  o body); rechaza si `now - started_at` < 50% del mínimo; marca `sospechoso` si
  está entre 50% y 100%; escribe en `points_ledger` (no update directo);
  recalcula cache; evalúa insignias; notifica subida de nivel.

## Onboarding (frontend, nuevas vistas full-screen sin tabbar)

`view-auth-landing` (logo + entrar/registrarse) → `view-auth-register`
(nombre, email, teléfono) → `view-auth-verify` (código OTP, con pista en dev) →
`view-onb-perfil` (país, ciudad, restricciones alimentarias, alergias, fuma,
preferencias sensoriales) → `view-onb-consent` (casilla de consentimiento) →
`view-home`.

`boot()`:
- sin token → `view-auth-landing`.
- con token → `GET /api/onboarding/status`; si `!done`, salta al primer paso
  incompleto; si `done`, carga y muestra Home.

Casos borde: email duplicado en registro → cambia a "iniciar sesión". Abandono
en verificación → user queda `pending`, no cuenta como activo.

## Logo

Marca SensoLab como **SVG inline** (swoosh naranja+teal + wordmark "SensoLab" +
"Solutions" + tagline), con la paleta que ya usa `index.html`
(`--orange #f2891c`, `--teal #3fb2bd`). Si se deja el PNG oficial en
`assets/sensolab-logo.png`, el markup lo prefiere.

## Orden de ejecución

1. Esquema (`db.js`) + migración in-place.
2. `ledger.js`, `badges.js`, `otp.js`; `gamification.js` desde BD.
3. `server.js` — rutas nuevas + cambios, sin romper las vivas.
4. `seed.js` — nuevo esquema, demo user onboardeado, todo vía ledger.
5. `index.html` — logo + vistas de onboarding + enrutado en `boot()`.
6. Pruebas end-to-end en navegador + README.
