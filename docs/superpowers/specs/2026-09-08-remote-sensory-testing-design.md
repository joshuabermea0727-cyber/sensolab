# SensoLab Community — Pruebas sensoriales a distancia (diseño)

Fecha: 2026-09-08
Estado: aprobado para construir ("todo" — spec completo, frontend primero)

## Alcance

Implementar el spec completo de "Pruebas sensoriales a distancia" como extensión
del modelo `session_catalog` / `user_sessions` del prototipo. Se respeta la lista
"Kill por ahora" del propio spec:

- Sin verificación biométrica automática.
- Sin geolocalización obligatoria (opcional/consentida como señal débil).
- Sin ML de detección de fraude (`integrity_score` es heurístico, reglas).
- Sin integración con proveedor de envíos (los kits se mueven a mano por estado).

Se construye en dos fases:

1. **Frontend primero** — pantallas + capa mock en el navegador que implementa
   todos los endpoints del spec. Todo el flujo es clickeable sin servidor.
2. **Backend después** — endpoints reales `/api/remote/*` + esquema SQLite. Se
   activa cambiando `window.SENSOLAB_REMOTE_MOCK = false` y borrando el mock.

## Archivos

| archivo | rol |
|---|---|
| `remote-mock.js` | API falsa en el navegador, persistida en `localStorage`. Seed de kits + una cuenta reviewer. |
| `remote.js` | Módulo de UI del flujo remoto: navegación, render, acciones. Llama al mock o a `/api/remote/*` según el flag. |
| `index.html` | + pantallas `.app-view` del flujo remoto, + CSS, + bridge `window.SL`, + 2 `<script>`. |
| `backend/remote.js` (fase 2) | Rutas Express + consultas. Reusa `db`, `requireAuth`, gamificación. |

## Contrato de API (mock y backend comparten forma)

Todo bajo `/api/remote`, con `Authorization: Bearer <token>` salvo donde se indique.

| método | ruta | descripción |
|---|---|---|
| GET | `/remote/sessions/eligible` | Catálogo remoto + estado del usuario (kit, envío, intento). |
| POST | `/remote/sessions/:slug/request-kit` | body `{ direccion_envio }` → crea `kit_shipments` (pendiente). |
| POST | `/remote/shipments/:id/confirm` | Usuario confirma recepción → habilita iniciar. |
| POST | `/remote/sessions/:slug/start` | body `{ checklist: {...}, setup_photo_url }` → registra `started_at` server-side. 403 si el envío no está confirmado. |
| POST | `/remote/sessions/:slug/submit` | body `{ submission_media_url, respuestas, geolocalizacion? }` → calcula `integrity_score`, enruta a auto_ok / manual_pending. |
| GET | `/remote/review-queue` | Solo `role = reviewer`. Intentos en `manual_pending` con fotos + flags. |
| POST | `/remote/review/:attemptId` | Solo reviewer. body `{ decision: 'aprobado'\|'rechazado', nota? }`. Aprobado → acredita puntos. |

### Estados

- `kit_shipments.estado`: `pendiente` → `enviado` → `entregado` → `confirmado`.
  (mock: avanza solo con un timer corto para simular logística; el usuario dispara `confirmado`.)
- `remote_attempts.estado_validacion`: `auto_ok` | `manual_pending` | `aprobado` | `rechazado`.

### Heurística `integrity_score` (0–100) — DECISIÓN DE NEGOCIO, ajustable

Empieza en 100 y resta:

| señal | penalización |
|---|---|
| `duracion_real_seg` < mínimo de la sesión | −40, flag `duracion_sospechosa` (alta) |
| sin `submission_media_url` | −50, flag `media_faltante` (alta) |
| `start` dentro de 60 s de `confirmado` y tracking != `entregado` | −25, flag `geolocalizacion_inconsistente`→`confirmacion_prematura` (media) |
| geolocalización consentida y lejos de la declarada | −15, flag (baja) |

Enrutamiento:

- `score >= 75` → `auto_ok`, puntos de inmediato.
- `40 <= score < 75` → `manual_pending`.
- `score < 40` → `manual_pending` + flag de severidad alta (nunca rechazo
  automático — coherente con el edge case de conectividad caída).

## Pantallas (`.app-view` push-views nuevas)

1. `view-remoto` — hub: sesiones remotas + estado; entrada a cola de revisión si reviewer.
2. `view-remoto-kit` — formulario de dirección + tracker de envío + "Confirmar recepción".
3. `view-remoto-checklist` — checklist obligatorio + foto de setup.
4. `view-remoto-activa` — ejecución guiada, timer server-verificado.
5. `view-remoto-submit` — captura de media de evidencia + respuestas.
6. `view-remoto-resultado` — auto_ok / manual_pending / rechazado (motivo genérico).
7. `view-remoto-cola` — cola de revisión del reviewer: fotos, flags, Aprobar/Rechazar.

Entrada: tarjeta "Sesiones a distancia →" arriba de la vista Sesiones. No se toca la tabbar.

## Acreditación de puntos

Aprobado (auto o manual) suma `session.points` con el mismo mecanismo que una
sesión presencial completada: fila de actividad, posible subida de nivel +
notificación. En el mock se refleja en `state.me` y se re-renderiza Inicio.
En backend fase 2: fila en el ledger de puntos (hoy `users.points` + `activity`).
