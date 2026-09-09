// ---------------------------------------------------------------------------
// ledger.js — points_ledger es la fuente de verdad de los puntos.
//
// Nadie hace `UPDATE users SET points = points + N`. Se inserta una fila en
// points_ledger y se llama recomputeUserPoints(). Si el cache (users.points) y
// el ledger divergen, gana el ledger.
// ---------------------------------------------------------------------------

import { db } from './db.js';

const insLedger = db.prepare(`
  INSERT INTO points_ledger (user_id, delta, reason, ref_type, ref_id, created_at)
  VALUES (@user_id, @delta, @reason, @ref_type, @ref_id, @created_at)
`);
const sumAll = db.prepare(
  'SELECT COALESCE(SUM(delta), 0) AS total FROM points_ledger WHERE user_id = ?'
);
const sumSince = db.prepare(
  'SELECT COALESCE(SUM(delta), 0) AS total FROM points_ledger WHERE user_id = ? AND created_at >= ?'
);
const setCache = db.prepare(
  'UPDATE users SET points = ?, weekly_delta = ? WHERE id = ?'
);

/** Inserta un movimiento de puntos. No recalcula el cache por sí solo. */
export function addLedger({ userId, delta, reason, refType = null, refId = null, at }) {
  insLedger.run({
    user_id: userId,
    delta,
    reason,
    ref_type: refType,
    ref_id: refId != null ? String(refId) : null,
    created_at: at || new Date().toISOString(),
  });
}

/** Lunes 00:00:00 UTC de la semana de `d` (para el delta semanal del ranking). */
export function startOfWeekISO(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // 0 = lunes
  x.setUTCDate(x.getUTCDate() - dow);
  return x.toISOString();
}

export function weeklyDelta(userId, ref = new Date()) {
  return sumSince.get(userId, startOfWeekISO(ref)).total;
}

/**
 * Recalcula users.points y users.weekly_delta desde el ledger. Devuelve el
 * total. Es la única forma legítima de mover el cache.
 */
export function recomputeUserPoints(userId, ref = new Date()) {
  const total = sumAll.get(userId).total;
  const week = weeklyDelta(userId, ref);
  setCache.run(total, week, userId);
  return total;
}
