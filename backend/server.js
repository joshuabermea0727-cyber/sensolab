// ---------------------------------------------------------------------------
// server.js — API REST + servidor estático de la PWA SensoLab Community.
//
// Arranque:   npm install  &&  npm run seed  &&  npm start
// Escucha en http://localhost:4000 y sirve ../index.html en "/".
// ---------------------------------------------------------------------------

import express from 'express';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { db } from './db.js';
import { signToken, requireAuth } from './auth.js';
import { levelInfo, nextStreak, todayISO, publicUser } from './gamification.js';
import { addLedger, recomputeUserPoints, weeklyDelta } from './ledger.js';
import { evaluateBadges } from './badges.js';
import { issueOtp, verifyOtp } from './otp.js';
import { askAssistant } from './assistant.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const REPO_ROOT = join(__dirname, '..');
const nowISO = () => new Date().toISOString();
const isDev = process.env.NODE_ENV !== 'production';

const app = express();
app.use(express.json());

// CORS abierto: la PWA puede servirse desde otro origen (Live Server, etc.).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) console.log(`${nowISO()}  ${req.method} ${req.path}`);
  next();
});

// =========================================================================
// Consultas preparadas
// =========================================================================
const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (name, email, phone, password_hash, initials, avatar_seed, status, last_active_on, created_at)
    VALUES (@name, @email, @phone, @password_hash, @initials, @avatar_seed, @status, @last_active_on, @created_at)
  `),
  activateUser: db.prepare("UPDATE users SET status = 'active' WHERE id = ?"),
  setOnboarded: db.prepare('UPDATE users SET onboarded_at = ?, country = ?, city = ? WHERE id = ?'),
  setConsentAt: db.prepare('UPDATE users SET consent_at = ? WHERE id = ?'),
  insertPrefs: db.prepare('INSERT INTO preferences (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING'),
  rankOf: db.prepare('SELECT COUNT(*) + 1 AS rank FROM users WHERE points > ? AND status = \'active\''),
  completedCount: db.prepare(
    "SELECT COUNT(*) AS c FROM user_sessions WHERE user_id = ? AND status = 'completed'"
  ),
  badgesOf: db.prepare(`
    SELECT b.slug, b.name, b.icon FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ? ORDER BY ub.earned_at
  `),
  allBadges: db.prepare('SELECT * FROM badges ORDER BY criterio_valor'),
  catalog: db.prepare('SELECT * FROM session_catalog ORDER BY sort_order'),
  sessionBySlug: db.prepare('SELECT * FROM session_catalog WHERE slug = ?'),
  sessionById: db.prepare('SELECT * FROM session_catalog WHERE id = ?'),
  userSession: db.prepare('SELECT * FROM user_sessions WHERE user_id = ? AND session_id = ?'),
  userSessionsAll: db.prepare('SELECT * FROM user_sessions WHERE user_id = ?'),
  startUserSession: db.prepare(`
    INSERT INTO user_sessions (user_id, session_id, status, progress_pct, points_awarded, started_at, completed_at)
    VALUES (@user_id, @session_id, 'in_progress', @progress_pct, 0, @started_at, NULL)
    ON CONFLICT(user_id, session_id) DO UPDATE SET
      status = 'in_progress', progress_pct = excluded.progress_pct,
      points_awarded = 0, started_at = excluded.started_at, completed_at = NULL
  `),
  completeUserSession: db.prepare(`
    UPDATE user_sessions SET status = 'completed', progress_pct = 100,
      points_awarded = @points_awarded, respuestas_json = @respuestas_json,
      sospechoso = @sospechoso, idempotency_key = @idempotency_key,
      completed_at = @completed_at
    WHERE user_id = @user_id AND session_id = @session_id
  `),
  updateStreak: db.prepare('UPDATE users SET streak_days = ?, last_active_on = ? WHERE id = ?'),
  addActivity: db.prepare('INSERT INTO activity (user_id, text_html, created_at) VALUES (?, ?, ?)'),
  recentActivity: db.prepare(`
    SELECT text_html, created_at FROM activity
    WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `),
  addNotif: db.prepare(
    'INSERT INTO notifications (user_id, icon, tipo, title, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  notifsOf: db.prepare(`
    SELECT id, icon, tipo, title, read, created_at FROM notifications
    WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50
  `),
  markNotifRead: db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?'),
  prefsOf: db.prepare('SELECT * FROM preferences WHERE user_id = ?'),
  leaderboard: db.prepare(`
    SELECT id, name, initials, points, weekly_delta, streak_days
    FROM users WHERE status = 'active' ORDER BY points DESC LIMIT ?
  `),
  sensoryProfile: db.prepare('SELECT * FROM user_sensory_profile WHERE user_id = ?'),
  upsertSensoryProfile: db.prepare(`
    INSERT INTO user_sensory_profile
      (user_id, dob, country, city, dietary_restrictions, allergies, sensory_prefs_json, smoker, notes, completed_at)
    VALUES (@user_id, @dob, @country, @city, @dietary_restrictions, @allergies, @sensory_prefs_json, @smoker, @notes, @completed_at)
    ON CONFLICT(user_id) DO UPDATE SET
      dob = excluded.dob, country = excluded.country, city = excluded.city,
      dietary_restrictions = excluded.dietary_restrictions, allergies = excluded.allergies,
      sensory_prefs_json = excluded.sensory_prefs_json, smoker = excluded.smoker,
      notes = excluded.notes, completed_at = excluded.completed_at
  `),
  grantConsent: db.prepare(`
    INSERT INTO consents (user_id, kind, granted_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id, kind) DO UPDATE SET granted_at = excluded.granted_at
  `),
  consentsOf: db.prepare('SELECT kind FROM consents WHERE user_id = ?'),
};

/** Transacción simple sobre node:sqlite. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const csv = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const initialsFrom = (name) =>
  name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || 'SL';

// =========================================================================
// Serializadores
// =========================================================================
function onboardingStatus(userRow) {
  const prof = q.sensoryProfile.get(userRow.id);
  const consents = q.consentsOf.all(userRow.id).map((r) => r.kind);
  const registered = true;
  const verified = userRow.status === 'active';
  const sensoryProfile = !!(prof && prof.completed_at);
  const consent = consents.includes('datos');
  return {
    registered, verified, sensoryProfile, consent,
    done: verified && sensoryProfile && consent,
    nextStep: !verified ? 'verify'
      : !sensoryProfile ? 'sensory-profile'
      : !consent ? 'consent' : 'done',
  };
}

function mePayload(userRow) {
  const rank = q.rankOf.get(userRow.points).rank;
  const sessionsCompleted = q.completedCount.get(userRow.id).c;
  return {
    ...publicUser(userRow, { rank, sessionsCompleted }),
    badges: q.badgesOf.all(userRow.id),
    onboarding: onboardingStatus(userRow),
  };
}

/** Une catálogo + estado del usuario + elegibilidad (nivel, prerequisito, perfil sensorial). */
function sessionsForUser(userRow) {
  const userLevel = levelInfo(userRow.points).level;
  const mine = new Map(q.userSessionsAll.all(userRow.id).map((r) => [r.session_id, r]));
  const prof = q.sensoryProfile.get(userRow.id);
  const blocked = new Set([...csv(prof?.allergies), ...csv(prof?.dietary_restrictions)]);

  return q.catalog.all().map((s) => {
    const us = mine.get(s.id);
    let status = 'available';
    if (us) status = us.status; // in_progress | completed
    let lockedReason = null;

    if (status !== 'completed') {
      if (userLevel < s.required_level) lockedReason = 'level';
      else if (s.prerequisite_session_id) {
        const pre = mine.get(s.prerequisite_session_id);
        if (!pre || pre.status !== 'completed') lockedReason = 'prereq';
      }
      if (!lockedReason) {
        const tags = csv(s.sensory_tags);
        if (tags.some((t) => blocked.has(t))) lockedReason = 'sensory';
      }
    }
    if (lockedReason) status = 'locked';

    return {
      slug: s.slug,
      name: s.name,
      description: s.description,
      sense: s.sense,
      points: s.points,
      durationMin: s.duration_min,
      minDurationSec: s.min_duration_sec,
      requiredLevel: s.required_level,
      prerequisiteSlug: s.prerequisite_session_id
        ? (q.sessionById.get(s.prerequisite_session_id)?.slug || null) : null,
      sensoryTags: csv(s.sensory_tags),
      status,
      lockedReason,
      progressPct: us ? us.progress_pct : 0,
      pointsAwarded: us ? us.points_awarded : 0,
      sospechoso: us ? !!us.sospechoso : false,
      completedAt: us ? us.completed_at : null,
    };
  });
}

function prefsPayload(userId) {
  const p = q.prefsOf.get(userId) || {};
  return {
    pushEnabled: !!p.push_enabled,
    soundEnabled: !!p.sound_enabled,
    highContrast: !!p.high_contrast,
    dailyReminders: !!p.daily_reminders,
    reminderHour: p.reminder_hour || '19:00',
  };
}

function sensoryPayload(userId) {
  const p = q.sensoryProfile.get(userId);
  if (!p) return { completed: false, dob: null, country: null, city: null,
    dietaryRestrictions: [], allergies: [], sensoryPrefs: {}, smoker: false, notes: null };
  return {
    completed: !!p.completed_at,
    dob: p.dob || null,
    country: p.country || null,
    city: p.city || null,
    dietaryRestrictions: csv(p.dietary_restrictions),
    allergies: csv(p.allergies),
    sensoryPrefs: p.sensory_prefs_json ? JSON.parse(p.sensory_prefs_json) : {},
    smoker: !!p.smoker,
    notes: p.notes || null,
  };
}

// =========================================================================
// Auth + registro
// =========================================================================
app.post('/api/auth/register', (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Nombre y correo son obligatorios.' });
  }
  const existing = q.userByEmail.get(email);
  if (existing) {
    // Sin fricción: si ya hay cuenta, esto es un login, no un registro.
    const otp = issueOtp(email, 'login');
    return res.json({
      mode: 'login', email,
      message: 'Ya existe una cuenta con ese correo. Te enviamos un código para entrar.',
      ...(isDev ? { devCode: otp.code } : {}),
    });
  }

  const hash = password ? bcrypt.hashSync(String(password), 10) : null;
  const info = q.insertUser.run({
    name, email, phone: phone || null, password_hash: hash,
    initials: initialsFrom(name),
    avatar_seed: Math.random().toString(36).slice(2, 10),
    status: 'pending', last_active_on: null, created_at: nowISO(),
  });
  const userRow = q.userById.get(info.lastInsertRowid);
  q.insertPrefs.run(userRow.id);

  const otp = issueOtp(email, 'verify');
  res.status(201).json({
    mode: 'register', userId: userRow.id, email, needsVerify: true,
    message: 'Cuenta creada. Verifica con el código que te enviamos.',
    ...(isDev ? { devCode: otp.code } : {}),
  });
});

app.post('/api/auth/request-otp', (req, res) => {
  const { email, purpose } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Falta el correo.' });
  const user = q.userByEmail.get(email);
  const p = purpose === 'login' || (user && user.status === 'active') ? 'login' : 'verify';
  const otp = issueOtp(email, p);
  res.json({ email, purpose: p, ...(isDev ? { devCode: otp.code } : {}) });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'Faltan correo y código.' });

  const ok = verifyOtp(email, code, 'verify') || verifyOtp(email, code, 'login');
  if (!ok) return res.status(401).json({ error: 'Código inválido o expirado.' });

  let userRow = q.userByEmail.get(email);
  if (!userRow) return res.status(404).json({ error: 'No hay cuenta con ese correo.' });
  if (userRow.status !== 'active') {
    q.activateUser.run(userRow.id);
    userRow = q.userById.get(userRow.id);
  }
  res.json({ token: signToken(userRow), user: mePayload(userRow) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const userRow = email ? q.userByEmail.get(email) : null;
  if (!userRow || !userRow.password_hash ||
      !bcrypt.compareSync(String(password || ''), userRow.password_hash)) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  if (userRow.status !== 'active') q.activateUser.run(userRow.id);
  res.json({ token: signToken(userRow), user: mePayload(q.userById.get(userRow.id)) });
});

// =========================================================================
// Perfil / estado / onboarding
// =========================================================================
app.get('/api/me', requireAuth, (req, res) => res.json(mePayload(req.user)));

app.get('/api/onboarding/status', requireAuth, (req, res) =>
  res.json(onboardingStatus(req.user)));

app.get('/api/me/summary', requireAuth, (req, res) => {
  const me = mePayload(req.user);
  const sessions = sessionsForUser(req.user);
  const activity = q.recentActivity.all(req.user.id, 8).map((r) => ({
    text: r.text_html, createdAt: r.created_at,
  }));
  const nextSession = sessions.find((s) => s.status === 'in_progress')
    || sessions.find((s) => s.status === 'available') || null;
  res.json({ me, sessions, activity, nextSession });
});

app.get('/api/me/badges', requireAuth, (req, res) => {
  const owned = new Set(q.badgesOf.all(req.user.id).map((b) => b.slug));
  const level = levelInfo(req.user.points).level;
  const completed = q.completedCount.get(req.user.id).c;
  const value = (b) => b.criterio_tipo === 'racha' ? req.user.streak_days
    : b.criterio_tipo === 'nivel' ? level : completed;
  res.json(q.allBadges.all().map((b) => ({
    slug: b.slug, name: b.name, icon: b.icon,
    criterio: b.criterio_tipo, objetivo: b.criterio_valor,
    progreso: Math.min(value(b), b.criterio_valor),
    earned: owned.has(b.slug),
  })));
});

app.get('/api/me/sensory-profile', requireAuth, (req, res) =>
  res.json(sensoryPayload(req.user.id)));

app.put('/api/me/sensory-profile', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.country || !b.city) {
    return res.status(400).json({ error: 'País y ciudad son obligatorios.' });
  }
  const now = nowISO();
  q.upsertSensoryProfile.run({
    user_id: req.user.id,
    dob: b.dob || null,
    country: String(b.country).trim(),
    city: String(b.city).trim(),
    dietary_restrictions: (b.dietaryRestrictions || []).join(','),
    allergies: (b.allergies || []).join(','),
    sensory_prefs_json: JSON.stringify(b.sensoryPrefs || {}),
    smoker: b.smoker ? 1 : 0,
    notes: b.notes || null,
    completed_at: now,
  });
  q.setOnboarded.run(q.userById.get(req.user.id).onboarded_at || now,
    String(b.country).trim(), String(b.city).trim(), req.user.id);
  res.json({ ...sensoryPayload(req.user.id), onboarding: onboardingStatus(q.userById.get(req.user.id)) });
});

app.post('/api/me/consent', requireAuth, (req, res) => {
  const kinds = Array.isArray(req.body?.kinds) ? req.body.kinds
    : [req.body?.kind || 'datos'];
  const now = nowISO();
  for (const k of kinds) q.grantConsent.run(req.user.id, String(k), now);
  q.setConsentAt.run(now, req.user.id);
  res.json({ ok: true, onboarding: onboardingStatus(q.userById.get(req.user.id)) });
});

app.get('/api/activity', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  res.json(q.recentActivity.all(req.user.id, limit).map((r) => ({
    text: r.text_html, createdAt: r.created_at,
  })));
});

// =========================================================================
// Sesiones
// =========================================================================
app.get('/api/sessions', requireAuth, (req, res) => res.json(sessionsForUser(req.user)));

app.post('/api/sessions/:slug/start', requireAuth, (req, res) => {
  const s = q.sessionBySlug.get(req.params.slug);
  if (!s) return res.status(404).json({ error: 'Sesión no encontrada.' });

  const view = sessionsForUser(req.user).find((x) => x.slug === s.slug);
  if (view.status === 'locked') {
    const msg = view.lockedReason === 'prereq'
      ? `Antes completa "${view.prerequisiteSlug}".`
      : view.lockedReason === 'sensory'
      ? 'Tu perfil sensorial bloquea esta sesión.'
      : `Necesitas Nivel ${s.required_level} para esta sesión.`;
    return res.status(403).json({ error: msg });
  }
  const existing = q.userSession.get(req.user.id, s.id);
  if (existing && existing.status === 'completed' && !s.repeatable) {
    return res.status(409).json({ error: 'Esta sesión ya está completada.' });
  }

  const startedAt = nowISO();
  q.startUserSession.run({
    user_id: req.user.id, session_id: s.id,
    progress_pct: existing ? existing.progress_pct : 0,
    started_at: startedAt,
  });
  res.json({
    ...sessionsForUser(req.user).find((x) => x.slug === s.slug),
    startedAt, minDurationSec: s.min_duration_sec,
  });
});

app.post('/api/sessions/:slug/complete', requireAuth, (req, res) => {
  const s = q.sessionBySlug.get(req.params.slug);
  if (!s) return res.status(404).json({ error: 'Sesión no encontrada.' });

  const view = sessionsForUser(req.user).find((x) => x.slug === s.slug);
  if (view.status === 'locked') {
    return res.status(403).json({ error: 'Sesión no disponible para tu perfil.' });
  }

  const existing = q.userSession.get(req.user.id, s.id);
  const idemKey = req.get('Idempotency-Key') || req.body?.idempotencyKey || null;

  if (existing && existing.status === 'completed') {
    // Idempotencia: misma clave => devolver el resultado previo, no 409.
    if (idemKey && existing.idempotency_key === idemKey) {
      return res.json({
        me: mePayload(req.user),
        session: view, awarded: 0, alreadyDone: true,
      });
    }
    if (!s.repeatable) {
      return res.status(409).json({
        error: 'Esta sesión ya estaba completada.',
        me: mePayload(req.user), session: view,
      });
    }
  }
  if (!existing || existing.status !== 'in_progress') {
    return res.status(409).json({ error: 'Primero inicia la sesión.' });
  }

  // --- integridad del temporizador (server-side) -------------------------
  const elapsedSec = (Date.parse(nowISO()) - Date.parse(existing.started_at)) / 1000;
  const min = s.min_duration_sec || 0;
  let sospechoso = 0;
  if (min > 0) {
    if (elapsedSec < min * 0.5) {
      return res.status(422).json({
        error: 'Muy rápido para ser una sesión válida. Tómate el tiempo indicado.',
        elapsedSec: Math.round(elapsedSec), minDurationSec: min,
      });
    }
    if (elapsedSec < min) sospechoso = 1;
  }

  const result = tx(() => {
    const today = todayISO();
    const before = levelInfo(req.user.points);

    // 1) fila en el ledger — NUNCA update directo de users.points
    addLedger({
      userId: req.user.id, delta: s.points,
      reason: 'session', refType: 'session', refId: s.id, at: nowISO(),
    });
    // 2) marcar la sesión
    q.completeUserSession.run({
      user_id: req.user.id, session_id: s.id,
      points_awarded: s.points,
      respuestas_json: req.body?.respuestas ? JSON.stringify(req.body.respuestas) : null,
      sospechoso, idempotency_key: idemKey,
      completed_at: nowISO(),
    });
    // 3) racha + recompute del cache desde el ledger
    const newStreak = nextStreak(req.user.streak_days, req.user.last_active_on, today);
    q.updateStreak.run(newStreak, today, req.user.id);
    recomputeUserPoints(req.user.id);

    let userRow = q.userById.get(req.user.id);
    q.addActivity.run(req.user.id, `Completaste <b>${s.name}</b>`, nowISO());

    // 4) subida de nivel
    const after = levelInfo(userRow.points);
    if (after.level > before.level) {
      q.addActivity.run(req.user.id, `Subiste al <b>Nivel ${after.level}</b>`, nowISO());
      q.addNotif.run(req.user.id, 'bolt', 'level',
        `Subiste al Nivel ${after.level} · ${after.levelName}`, nowISO());
    }
    // 5) insignias
    const newBadges = evaluateBadges(userRow);
    if (newBadges.length) {
      recomputeUserPoints(req.user.id); // por si alguna insignia da puntos
      userRow = q.userById.get(req.user.id);
    }
    return { userRow, newBadges };
  });

  res.json({
    me: mePayload(result.userRow),
    session: sessionsForUser(result.userRow).find((x) => x.slug === s.slug),
    awarded: s.points,
    sospechoso: !!sospechoso,
    newBadges: result.newBadges,
  });
});

// =========================================================================
// Comunidad / notificaciones / preferencias
// =========================================================================
app.get('/api/leaderboard', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = q.leaderboard.all(limit);
  const list = rows.map((r, i) => ({
    rank: i + 1, name: r.name, initials: r.initials,
    points: r.points, weeklyDelta: r.weekly_delta,
    ...levelInfo(r.points), isMe: r.id === req.user.id,
  }));
  if (!list.some((x) => x.isMe)) {
    const me = req.user;
    list.push({
      rank: q.rankOf.get(me.points).rank, name: me.name, initials: me.initials,
      points: me.points, weeklyDelta: me.weekly_delta,
      ...levelInfo(me.points), isMe: true,
    });
  }
  res.json(list);
});

app.get('/api/notifications', requireAuth, (req, res) => {
  res.json(q.notifsOf.all(req.user.id).map((n) => ({
    id: n.id, icon: n.icon, tipo: n.tipo, title: n.title,
    read: !!n.read, createdAt: n.created_at,
  })));
});

app.patch('/api/notifications/:id/read', requireAuth, (req, res) => {
  q.markNotifRead.run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

const PREF_KEYS = {
  pushEnabled: 'push_enabled',
  soundEnabled: 'sound_enabled',
  highContrast: 'high_contrast',
  dailyReminders: 'daily_reminders',
};

app.get('/api/preferences', requireAuth, (req, res) => res.json(prefsPayload(req.user.id)));

app.patch('/api/preferences', requireAuth, (req, res) => {
  const body = req.body || {};
  const sets = [];
  const vals = [];
  for (const [apiKey, col] of Object.entries(PREF_KEYS)) {
    if (apiKey in body) { sets.push(`${col} = ?`); vals.push(body[apiKey] ? 1 : 0); }
  }
  if ('reminderHour' in body && /^\d{2}:\d{2}$/.test(body.reminderHour)) {
    sets.push('reminder_hour = ?'); vals.push(body.reminderHour);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar.' });
  vals.push(req.user.id);
  db.prepare(`UPDATE preferences SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals);
  res.json(prefsPayload(req.user.id));
});

// =========================================================================
// Asistente de IA (público — también lo usa el sitio de marketing)
// =========================================================================
app.post('/api/assistant', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anon')
      .toString().split(',')[0].trim();
    const out = await askAssistant(req.body || {}, ip);
    res.json(out);
  } catch (err) {
    console.error('assistant error', err);
    res.status(500).json({ reply: 'El asistente falló. Intenta más tarde.', configured: true });
  }
});

// =========================================================================
// Salud + estáticos
// =========================================================================
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, service: 'sensolab-community', time: nowISO() }));

app.use(express.static(REPO_ROOT, { extensions: ['html'] }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(PORT, () => {
  console.log(`\n  SensoLab Community API`);
  console.log(`  ├─ API      http://localhost:${PORT}/api`);
  console.log(`  ├─ App      http://localhost:${PORT}/`);
  console.log(`  └─ Health   http://localhost:${PORT}/api/health\n`);
});
