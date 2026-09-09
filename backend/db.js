// ---------------------------------------------------------------------------
// db.js — conexión SQLite + esquema + migración in-place.
//
// Módulo nativo `node:sqlite` (Node >= 22.5): síncrono, sin binarios.
// Para producción el mismo esquema se migra a Postgres cambiando solo este
// archivo.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SENSOLAB_DB_PATH || join(__dirname, 'sensolab.db');

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// Esquema base. `IF NOT EXISTS` en todo → arrancar es idempotente.
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    email          TEXT    NOT NULL UNIQUE,
    password_hash  TEXT,                        -- null => cuenta solo-OTP
    initials       TEXT    NOT NULL,
    points         INTEGER NOT NULL DEFAULT 0,  -- CACHE de points_ledger
    weekly_delta   INTEGER NOT NULL DEFAULT 0,  -- CACHE (se recalcula del ledger)
    streak_days    INTEGER NOT NULL DEFAULT 0,
    last_active_on TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS level_tiers (
    level      INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    min_points INTEGER NOT NULL
  );

  -- Fuente de verdad de los puntos. users.points es un cache derivado de aquí.
  CREATE TABLE IF NOT EXISTS points_ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta      INTEGER NOT NULL,
    reason     TEXT    NOT NULL,               -- session | badge | manual_adjustment | seed
    ref_type   TEXT,                           -- 'session' | 'badge' | null
    ref_id     TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session_catalog (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                   TEXT    NOT NULL UNIQUE,
    name                   TEXT    NOT NULL,
    description            TEXT    NOT NULL,
    sense                  TEXT    NOT NULL,   -- taste | touch | smell | sound | sight
    points                 INTEGER NOT NULL,
    duration_min           INTEGER NOT NULL,
    duration_sec           INTEGER NOT NULL DEFAULT 0,
    min_duration_sec       INTEGER NOT NULL DEFAULT 0,   -- server-enforced
    required_level         INTEGER NOT NULL DEFAULT 1,
    prerequisite_session_id INTEGER REFERENCES session_catalog(id) ON DELETE SET NULL,
    sensory_tags           TEXT    NOT NULL DEFAULT '',  -- csv: 'gluten,nueces,lactosa,citrico'
    repeatable             INTEGER NOT NULL DEFAULT 0,
    sort_order             INTEGER NOT NULL DEFAULT 0
  );

  -- Estado de cada sesión POR usuario == session_attempts del spec.
  CREATE TABLE IF NOT EXISTS user_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id      INTEGER NOT NULL REFERENCES session_catalog(id) ON DELETE CASCADE,
    status          TEXT    NOT NULL DEFAULT 'in_progress',  -- in_progress | completed
    progress_pct    INTEGER NOT NULL DEFAULT 0,
    points_awarded  INTEGER NOT NULL DEFAULT 0,
    respuestas_json TEXT,
    sospechoso      INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT,
    started_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT,
    UNIQUE (user_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS user_sensory_profile (
    user_id               INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    dob                   TEXT,
    country               TEXT,
    city                  TEXT,
    dietary_restrictions  TEXT NOT NULL DEFAULT '',   -- csv
    allergies             TEXT NOT NULL DEFAULT '',   -- csv
    sensory_prefs_json    TEXT,
    smoker                INTEGER NOT NULL DEFAULT 0,
    notes                 TEXT,
    completed_at          TEXT
  );

  CREATE TABLE IF NOT EXISTS consents (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,               -- 'datos' | 'estudios_socio'
    granted_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, kind)
  );

  CREATE TABLE IF NOT EXISTS auth_otps (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    code       TEXT    NOT NULL,
    purpose    TEXT    NOT NULL DEFAULT 'verify',  -- verify | login
    expires_at TEXT    NOT NULL,
    consumed   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text_html  TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    icon       TEXT    NOT NULL DEFAULT 'clock',
    tipo       TEXT    NOT NULL DEFAULT 'system',   -- system | level | badge | community | session
    title      TEXT    NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS preferences (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push_enabled    INTEGER NOT NULL DEFAULT 1,
    sound_enabled   INTEGER NOT NULL DEFAULT 1,
    high_contrast   INTEGER NOT NULL DEFAULT 0,
    daily_reminders INTEGER NOT NULL DEFAULT 1,
    reminder_hour   TEXT    NOT NULL DEFAULT '19:00'
  );

  CREATE TABLE IF NOT EXISTS badges (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    icon          TEXT NOT NULL DEFAULT 'shield',   -- shield | bolt | smell
    criterio_tipo TEXT NOT NULL DEFAULT 'sesiones_count', -- racha | nivel | sesiones_count
    criterio_valor INTEGER NOT NULL DEFAULT 1,
    points        INTEGER NOT NULL DEFAULT 0        -- puntos extra al obtenerla
  );

  CREATE TABLE IF NOT EXISTS user_badges (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_id   INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    earned_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, badge_id)
  );

  CREATE INDEX IF NOT EXISTS idx_activity_user      ON activity(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_ledger_user        ON points_ledger(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_users_points       ON users(points DESC);
  CREATE INDEX IF NOT EXISTS idx_otps_email         ON auth_otps(email, purpose);
`);

// ---------------------------------------------------------------------------
// Migración in-place: añade columnas nuevas a bases ya creadas con el esquema
// viejo. SQLite no tiene "ADD COLUMN IF NOT EXISTS", así que se intenta y se
// ignora el error de "duplicate column".
// ---------------------------------------------------------------------------
const ADD_COLUMNS = [
  ['users', 'phone', 'TEXT'],
  ['users', 'avatar_seed', 'TEXT'],
  ['users', "status", "TEXT NOT NULL DEFAULT 'active'"],
  ['users', 'country', 'TEXT'],
  ['users', 'city', 'TEXT'],
  ['users', 'onboarded_at', 'TEXT'],
  ['users', 'consent_at', 'TEXT'],
  ['session_catalog', 'duration_sec', 'INTEGER NOT NULL DEFAULT 0'],
  ['session_catalog', 'min_duration_sec', 'INTEGER NOT NULL DEFAULT 0'],
  ['session_catalog', 'prerequisite_session_id', 'INTEGER'],
  ['session_catalog', "sensory_tags", "TEXT NOT NULL DEFAULT ''"],
  ['session_catalog', 'repeatable', 'INTEGER NOT NULL DEFAULT 0'],
  ['user_sessions', 'respuestas_json', 'TEXT'],
  ['user_sessions', 'sospechoso', 'INTEGER NOT NULL DEFAULT 0'],
  ['user_sessions', 'idempotency_key', 'TEXT'],
  ['preferences', "reminder_hour", "TEXT NOT NULL DEFAULT '19:00'"],
  ['notifications', "tipo", "TEXT NOT NULL DEFAULT 'system'"],
  ['badges', "criterio_tipo", "TEXT NOT NULL DEFAULT 'sesiones_count'"],
  ['badges', 'criterio_valor', 'INTEGER NOT NULL DEFAULT 1'],
  ['badges', 'points', 'INTEGER NOT NULL DEFAULT 0'],
];

for (const [table, col, type] of ADD_COLUMNS) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch (err) {
    if (!String(err.message || err).includes('duplicate column name')) {
      // Cualquier otro error sí importa.
      console.warn(`migración ${table}.${col}:`, err.message || err);
    }
  }
}

export default db;
