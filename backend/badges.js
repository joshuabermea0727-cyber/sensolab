// ---------------------------------------------------------------------------
// badges.js — evaluación y otorgamiento de insignias.
//
// Criterios soportados (badges.criterio_tipo):
//   racha           -> streak_days >= criterio_valor
//   nivel           -> nivel actual >= criterio_valor
//   sesiones_count  -> sesiones completadas >= criterio_valor
//
// Otorgar una insignia: fila en user_badges + (si tiene points) fila en
// points_ledger + notificación + actividad.
// ---------------------------------------------------------------------------

import { db } from './db.js';
import { levelInfo } from './gamification.js';
import { addLedger } from './ledger.js';

const allBadges = db.prepare('SELECT * FROM badges');
const ownedBadgeIds = db.prepare(
  'SELECT badge_id FROM user_badges WHERE user_id = ?'
);
const completedCount = db.prepare(
  "SELECT COUNT(*) AS c FROM user_sessions WHERE user_id = ? AND status = 'completed'"
);
const grantBadge = db.prepare(
  'INSERT INTO user_badges (user_id, badge_id, earned_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
);
const addNotif = db.prepare(
  'INSERT INTO notifications (user_id, icon, tipo, title, created_at) VALUES (?, ?, ?, ?, ?)'
);
const addActivity = db.prepare(
  'INSERT INTO activity (user_id, text_html, created_at) VALUES (?, ?, ?)'
);

function meets(badge, { streakDays, level, completed }) {
  if (badge.criterio_tipo === 'racha') return streakDays >= badge.criterio_valor;
  if (badge.criterio_tipo === 'nivel') return level >= badge.criterio_valor;
  if (badge.criterio_tipo === 'sesiones_count') return completed >= badge.criterio_valor;
  return false;
}

/**
 * Revisa todas las insignias que el usuario aún no tiene y otorga las que
 * cumpla. Devuelve el array de insignias recién otorgadas.
 * `userRow` debe traer points y streak_days actualizados.
 */
export function evaluateBadges(userRow, { at } = {}) {
  const now = at || new Date().toISOString();
  const owned = new Set(ownedBadgeIds.all(userRow.id).map((r) => r.badge_id));
  const stats = {
    streakDays: userRow.streak_days,
    level: levelInfo(userRow.points).level,
    completed: completedCount.get(userRow.id).c,
  };

  const granted = [];
  for (const badge of allBadges.all()) {
    if (owned.has(badge.id)) continue;
    if (!meets(badge, stats)) continue;

    grantBadge.run(userRow.id, badge.id, now);
    if (badge.points > 0) {
      addLedger({
        userId: userRow.id, delta: badge.points,
        reason: 'badge', refType: 'badge', refId: badge.id, at: now,
      });
    }
    addNotif.run(userRow.id, 'shield', 'badge', `Ganaste la insignia ${badge.name}`, now);
    addActivity.run(userRow.id, `Ganaste la insignia <b>${badge.name}</b>`, now);
    granted.push({ slug: badge.slug, name: badge.name, icon: badge.icon });
  }
  return granted;
}
