// ---------------------------------------------------------------------------
// gamification.js — reglas del loop: niveles, racha, serialización.
//
// El nivel es DERIVADO de los puntos (nunca se guarda). Los umbrales viven en
// la tabla `level_tiers`; si está vacía se usa el fallback de abajo.
// ---------------------------------------------------------------------------

import { db } from './db.js';

// Fallback si level_tiers no está sembrada todavía.
export const LEVELS_FALLBACK = [
  { level: 1, name: 'Aprendiz',          at: 0 },
  { level: 2, name: 'Catador',           at: 250 },
  { level: 3, name: 'Explorador',        at: 1000 },
  { level: 4, name: 'Curador',           at: 1400 },
  { level: 5, name: 'Curador Sensorial', at: 2200 },
];

const tiersStmt = db.prepare(
  'SELECT level, name, min_points AS at FROM level_tiers ORDER BY min_points ASC'
);

/** Umbrales de nivel, de la BD o del fallback. Se relee en cada llamada
 *  (SQLite local, coste irrelevante) para que el seed surta efecto sin reinicio. */
export function tiers() {
  const rows = tiersStmt.all();
  return rows.length ? rows : LEVELS_FALLBACK;
}

/** Nivel actual + cuánto falta para el siguiente. `next*` es null en el tope. */
export function levelInfo(points) {
  const T = tiers();
  let current = T[0];
  for (const l of T) {
    if (points >= l.at) current = l;
    else break;
  }
  const next = T.find((l) => l.at > points) || null;
  return {
    level: current.level,
    levelName: current.name,
    nextLevelName: next ? next.name : null,
    nextLevelAt: next ? next.at : null,
    pointsToNext: next ? next.at - points : 0,
  };
}

/**
 * Nueva racha al completar una sesión HOY.
 * - Mismo día -> sin cambio.  - Día consecutivo -> +1.  - Hueco 2+ días -> 1.
 * `lastActiveOn` y `today` son 'YYYY-MM-DD'.
 */
export function nextStreak(currentStreak, lastActiveOn, today) {
  if (lastActiveOn === today) return currentStreak;
  if (lastActiveOn) {
    const diffDays = Math.round(
      (Date.parse(today) - Date.parse(lastActiveOn)) / 86_400_000
    );
    if (diffDays === 1) return currentStreak + 1;
  }
  return 1;
}

/** 'YYYY-MM-DD' de hoy (UTC). */
export function todayISO(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** Serializa un usuario a la forma que consume el frontend. */
export function publicUser(row, { rank = null, sessionsCompleted = 0 } = {}) {
  const info = levelInfo(row.points);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone || null,
    initials: row.initials,
    status: row.status || 'active',
    country: row.country || null,
    city: row.city || null,
    onboardedAt: row.onboarded_at || null,
    points: row.points,
    weeklyDelta: row.weekly_delta,
    streakDays: row.streak_days,
    rank,
    sessionsCompleted,
    ...info,
  };
}
