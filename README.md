# SensoLab Community — PWA + backend local

App tipo iOS (onboarding, gamificación, sesiones sensoriales, ranking, pruebas
a distancia) con un **backend real**: Node + Express + SQLite embebido
(`node:sqlite`). Todo corre en tu máquina; nada se despliega.

```
sensolab-community/
├── index.html            ← la PWA (HTML + CSS + JS, sin build). Habla con /api.
├── remote-mock.js        ← API falsa en el navegador para "sesiones a distancia" (fase 1)
├── remote.js             ← UI del flujo remoto
├── backend/
│   ├── server.js           rutas + servidor estático
│   ├── db.js               conexión + esquema + migración in-place
│   ├── gamification.js     niveles (tabla level_tiers), racha, serialización
│   ├── ledger.js           points_ledger = fuente de verdad de los puntos
│   ├── badges.js           evaluación/otorgamiento de insignias
│   ├── otp.js              códigos OTP de registro/login (dev: 000000)
│   ├── auth.js             JWT + middleware
│   └── seed.js             datos demo (reproducen el prototipo + onboarding)
├── docs/superpowers/specs/ ← diseño de ejecución (app completa + feature remota)
├── Dockerfile · docker-compose.yml
```

---

## Correr sin Docker

Requiere **Node ≥ 22.5** (usa `node:sqlite` integrado).

```bash
cd backend
npm install
npm run seed        # crea sensolab.db con los datos demo
npm start
```

Abre **http://localhost:4000**. Sin sesión iniciada verás la pantalla de
bienvenida: **Crear cuenta**, **Ya tengo cuenta** o **Entrar como demo (Joshua)**.

| comando         | qué hace                                     |
|-----------------|----------------------------------------------|
| `npm start`     | API + página en `:4000`                      |
| `npm run dev`   | igual, con recarga (`node --watch`)          |
| `npm run seed`  | inserta lo que falte (idempotente)           |
| `npm run reset` | **borra todo** y vuelve a sembrar            |

---

## Autenticación

- **Registro**: nombre + correo (+ teléfono opcional) → código OTP → activa la
  cuenta. En desarrollo el código **siempre es `000000`** y se muestra en la
  pantalla; `otp.js` lo cambia por envío real en producción.
- **Login sin contraseña**: "Ya tengo cuenta" → correo → código OTP.
- **Login con contraseña**: `POST /api/auth/login` sigue funcionando para las
  cuentas demo (`demo1234`).
- **Demo**: `joshua@sensolab.dev` / `demo1234` — ya viene onboardeado.

Tras verificar, si el onboarding no está completo la app enruta al primer paso
pendiente: **perfil sensorial** (país, ciudad, restricciones, alergias) →
**consentimiento** → Home.

---

## Modelo de datos (resumen)

- `points_ledger` es la **fuente de verdad** de los puntos. `users.points` es un
  cache que se recalcula con `recomputeUserPoints()`. Nunca se hace
  `UPDATE users SET points = points + N`.
- `level_tiers` define los umbrales de nivel (no hardcodeados en el front).
- `session_catalog` tiene `min_duration_sec` (mínimo server-enforced),
  `prerequisite_session_id` y `sensory_tags`.
- `user_sensory_profile` guarda el "de dónde eres" + restricciones/alergias, que
  **bloquean** sesiones cuyo `sensory_tags` choque.
- `badges` lleva `criterio_tipo` (`racha` | `nivel` | `sesiones_count`) y
  `criterio_valor`; `badges.js` las otorga al completar sesiones.
- `db.js` migra bases viejas in-place con `ALTER TABLE … ADD COLUMN` defensivo.

---

## API

Todo bajo `/api`. Las rutas de datos piden `Authorization: Bearer <token>`.

| método | ruta | descripción |
|--------|------|-------------|
| POST  | `/api/auth/register`            | `{name,email,phone?}` → cuenta `pending` + OTP. Email duplicado → `{mode:'login'}`. |
| POST  | `/api/auth/request-otp`         | `{email}` → emite OTP (en dev: `devCode`). |
| POST  | `/api/auth/verify-otp`          | `{email,code}` → activa la cuenta → `{token,user}`. |
| POST  | `/api/auth/login`               | `{email,password}` → `{token,user}`. |
| GET   | `/api/me`                       | perfil: puntos, nivel, racha, ranking, badges, `onboarding`. |
| GET   | `/api/onboarding/status`        | `{registered,verified,sensoryProfile,consent,done,nextStep}`. |
| GET   | `/api/me/summary`               | Home en una llamada: `{me,sessions,activity,nextSession}`. |
| GET   | `/api/me/badges`                | insignias con progreso (`progreso`/`objetivo`/`earned`). |
| GET/PUT | `/api/me/sensory-profile`     | cuestionario "de dónde eres" + restricciones. |
| POST  | `/api/me/consent`               | `{kinds:['datos',…]}`. |
| GET   | `/api/activity?limit=8`         | actividad reciente. |
| GET   | `/api/sessions`                 | catálogo + estado + elegibilidad (`status`, `lockedReason`). |
| POST  | `/api/sessions/:slug/start`     | registra `started_at` server-side → `{…,startedAt,minDurationSec}`. |
| POST  | `/api/sessions/:slug/complete`  | idempotente (`Idempotency-Key`); rechaza si tardó < 50% del mínimo; marca `sospechoso` entre 50–100%; escribe en `points_ledger`; evalúa insignias. |
| GET   | `/api/leaderboard?limit=20`     | ranking (te incluye aunque no entres al top). |
| GET   | `/api/notifications`            | notificaciones. |
| PATCH | `/api/notifications/:id/read`   | marcar leída. |
| GET/PATCH | `/api/preferences`          | toggles + `reminderHour`. |
| GET   | `/api/health`                  | estado (sin auth). |

### Integridad del "loop" de puntos

- El nivel se **calcula** desde `points` (tabla `level_tiers`), nunca se guarda.
- Completar una sesión: fila en `points_ledger` (`reason='session'`), recompute
  del cache, racha, notificación si subes de nivel, evaluación de insignias.
- **Temporizador server-side**: `start` guarda `started_at`; `complete` compara
  contra `min_duration_sec`. Rápido de más → 422; sospechoso → se acredita pero
  con `sospechoso=1`.
- **Elegibilidad server-side**: nivel + prerequisito + perfil sensorial. El chip
  `Bloqueadas` del front es reflejo, no la regla.

---

## Pruebas sensoriales a distancia

Extensión (kit a domicilio + evidencia guiada + `integrity_score` heurístico +
cola de revisión manual). Hoy corre sobre `remote-mock.js` en el navegador
(persistido en `localStorage`). Para conectarlo a un backend real:
`window.SENSOLAB_REMOTE_MOCK = false` y implementar `/api/remote/*` con el mismo
contrato. Ver `docs/superpowers/specs/2026-09-08-remote-sensory-testing-design.md`.

---

## Logo

`index.html` dibuja la marca SensoLab como **SVG inline** (`SENSOLAB_LOGO`). Si
dejas el PNG oficial en `assets/sensolab-logo.png` puedes cambiar los
`<span data-logo>` por un `<img>`.

---

## Notas

- SQLite en archivo (`backend/sensolab.db`), ignorado por git. Para producción el
  mismo esquema se migra a Postgres cambiando solo `db.js`.
- `JWT_SECRET` tiene fallback de desarrollo; en despliegue real debe venir del
  entorno. En producción (`NODE_ENV=production`) los OTP se generan aleatorios y
  ya no se devuelven en la respuesta.
- No hay rate-limiting ni envío real de correo/SMS: es un entorno local.
