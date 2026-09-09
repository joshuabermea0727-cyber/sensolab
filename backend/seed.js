// ---------------------------------------------------------------------------
// seed.js — datos demo que reproducen el prototipo + onboarding completo.
//
//   node seed.js            -> inserta lo que falte (idempotente)
//   node seed.js --reset    -> borra todo y vuelve a sembrar
//
// Login demo:  joshua@sensolab.dev  /  demo1234   (o código OTP 000000 en dev)
// ---------------------------------------------------------------------------

import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { recomputeUserPoints } from './ledger.js';

const RESET = process.argv.includes('--reset');

const ALL_TABLES = [
  'user_badges', 'badges', 'notifications', 'activity', 'points_ledger',
  'user_sessions', 'user_sensory_profile', 'consents', 'auth_otps',
  'preferences', 'session_catalog', 'level_tiers', 'users',
];

if (RESET) {
  for (const t of ALL_TABLES) {
    db.exec(`DELETE FROM ${t};`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name = '${t}';`);
  }
  console.log('· tablas vaciadas (--reset)');
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const hoursAgo = (n) => new Date(Date.now() - n * 3_600_000).toISOString();
const todayStr = new Date().toISOString().slice(0, 10);
const yesterdayStr = daysAgo(1).slice(0, 10);

// ---------------------------------------------------------------------------
// Niveles
// ---------------------------------------------------------------------------
const TIERS = [
  { level: 1, name: 'Aprendiz',          min_points: 0 },
  { level: 2, name: 'Catador',           min_points: 250 },
  { level: 3, name: 'Explorador',        min_points: 1000 },
  { level: 4, name: 'Curador',           min_points: 1400 },
  { level: 5, name: 'Curador Sensorial', min_points: 2200 },
];
const insTier = db.prepare(`
  INSERT INTO level_tiers (level, name, min_points) VALUES (@level, @name, @min_points)
  ON CONFLICT(level) DO UPDATE SET name = excluded.name, min_points = excluded.min_points
`);
for (const t of TIERS) insTier.run(t);

// ---------------------------------------------------------------------------
// Catálogo de sesiones (con prerequisitos, tags sensoriales y mínimos server)
// ---------------------------------------------------------------------------
const CATALOG = [
  { slug: 'cata-sabor', name: 'Cata de Sabor', description: 'Perfil umami · 5 muestras',
    sense: 'taste', points: 50, duration_min: 12, min_duration_sec: 120,
    required_level: 1, prerequisite_slug: null, sensory_tags: 'gluten,soya', sort_order: 1 },
  { slug: 'experiencia-sonora', name: 'Experiencia Sonora', description: 'Sonido de empaque',
    sense: 'sound', points: 35, duration_min: 8, min_duration_sec: 90,
    required_level: 1, prerequisite_slug: null, sensory_tags: '', sort_order: 2 },
  { slug: 'textura-tactil', name: 'Textura Táctil', description: '5 materiales a ciegas',
    sense: 'touch', points: 45, duration_min: 10, min_duration_sec: 100,
    required_level: 1, prerequisite_slug: null, sensory_tags: '', sort_order: 3 },
  { slug: 'prueba-olfativa', name: 'Prueba Olfativa', description: 'Fragancia cítrica',
    sense: 'smell', points: 40, duration_min: 9, min_duration_sec: 90,
    required_level: 1, prerequisite_slug: null, sensory_tags: 'citrico', sort_order: 4 },
  { slug: 'percepcion-visual', name: 'Percepción Visual', description: 'Discriminación de color',
    sense: 'sight', points: 60, duration_min: 10, min_duration_sec: 120,
    required_level: 3, prerequisite_slug: null, sensory_tags: '', sort_order: 5 },
  { slug: 'cata-avanzada', name: 'Cata Avanzada', description: 'Umami + acidez · 8 muestras',
    sense: 'taste', points: 80, duration_min: 15, min_duration_sec: 180,
    required_level: 2, prerequisite_slug: 'cata-sabor', sensory_tags: 'gluten,soya,lactosa', sort_order: 6 },
];

const insSession = db.prepare(`
  INSERT INTO session_catalog
    (slug, name, description, sense, points, duration_min, duration_sec, min_duration_sec, required_level, sensory_tags, sort_order)
  VALUES (@slug, @name, @description, @sense, @points, @duration_min, @duration_sec, @min_duration_sec, @required_level, @sensory_tags, @sort_order)
  ON CONFLICT(slug) DO UPDATE SET
    name = excluded.name, description = excluded.description, sense = excluded.sense,
    points = excluded.points, duration_min = excluded.duration_min,
    duration_sec = excluded.duration_sec, min_duration_sec = excluded.min_duration_sec,
    required_level = excluded.required_level, sensory_tags = excluded.sensory_tags,
    sort_order = excluded.sort_order
`);
for (const s of CATALOG) {
  insSession.run({
    slug: s.slug, name: s.name, description: s.description, sense: s.sense,
    points: s.points, duration_min: s.duration_min, duration_sec: s.duration_min * 60,
    min_duration_sec: s.min_duration_sec, required_level: s.required_level,
    sensory_tags: s.sensory_tags, sort_order: s.sort_order,
  });
}
// segunda pasada: enlazar prerequisitos por slug
const setPrereq = db.prepare(
  'UPDATE session_catalog SET prerequisite_session_id = (SELECT id FROM session_catalog WHERE slug = ?) WHERE slug = ?'
);
for (const s of CATALOG) if (s.prerequisite_slug) setPrereq.run(s.prerequisite_slug, s.slug);

const sessBySlug = (slug) => db.prepare('SELECT * FROM session_catalog WHERE slug = ?').get(slug);

// ---------------------------------------------------------------------------
// Insignias (con criterio real)
// ---------------------------------------------------------------------------
const BADGES = [
  { slug: 'primer-cata',        name: 'Primera Sesión',      icon: 'shield', criterio_tipo: 'sesiones_count', criterio_valor: 1,  points: 0 },
  { slug: 'cinco-sesiones',     name: 'Cinco Sesiones',      icon: 'shield', criterio_tipo: 'sesiones_count', criterio_valor: 5,  points: 25 },
  { slug: 'racha-5',            name: 'Racha 5 días',        icon: 'bolt',   criterio_tipo: 'racha',          criterio_valor: 5,  points: 0 },
  { slug: 'racha-7',            name: 'Racha 7 días',        icon: 'bolt',   criterio_tipo: 'racha',          criterio_valor: 7,  points: 30 },
  { slug: 'nivel-3',            name: 'Explorador',          icon: 'shield', criterio_tipo: 'nivel',          criterio_valor: 3,  points: 0 },
  { slug: 'explorador-olfativo', name: 'Explorador Olfativo', icon: 'smell', criterio_tipo: 'sesiones_count', criterio_valor: 3,  points: 0 },
];
const insBadge = db.prepare(`
  INSERT INTO badges (slug, name, icon, criterio_tipo, criterio_valor, points)
  VALUES (@slug, @name, @icon, @criterio_tipo, @criterio_valor, @points)
  ON CONFLICT(slug) DO UPDATE SET
    name = excluded.name, icon = excluded.icon, criterio_tipo = excluded.criterio_tipo,
    criterio_valor = excluded.criterio_valor, points = excluded.points
`);
for (const b of BADGES) insBadge.run(b);

// ---------------------------------------------------------------------------
// Usuarios — puntos SIEMPRE vía points_ledger, users.points es cache.
// ---------------------------------------------------------------------------
const PASSWORD_HASH = bcrypt.hashSync('demo1234', 10);

const USERS = [
  { name: 'María R.',   email: 'maria@sensolab.dev',  initials: 'MR', points: 1420, weekly: 210, streak: 9, country: 'México', city: 'Monterrey' },
  { name: 'Diego L.',   email: 'diego@sensolab.dev',  initials: 'DL', points: 1180, weekly: 160, streak: 6, country: 'México', city: 'CDMX' },
  { name: 'Ana S.',     email: 'ana@sensolab.dev',    initials: 'AS', points: 1050, weekly: 140, streak: 4, country: 'México', city: 'Guadalajara' },
  { name: 'Pablo C.',   email: 'pablo@sensolab.dev',  initials: 'PC', points: 890,  weekly: 120, streak: 3, country: 'México', city: 'Puebla' },
  { name: 'Laura M.',   email: 'laura@sensolab.dev',  initials: 'LM', points: 845,  weekly: 95,  streak: 2, country: 'México', city: 'Querétaro' },
  { name: 'Carlos V.',  email: 'carlos@sensolab.dev', initials: 'CV', points: 800,  weekly: 60,  streak: 2, country: 'México', city: 'Mérida' },
  { name: 'Sofía T.',   email: 'sofia@sensolab.dev',  initials: 'ST', points: 760,  weekly: 55,  streak: 1, country: 'México', city: 'Toluca' },
  { name: 'Joshua Bermea', email: 'joshua@sensolab.dev', initials: 'JB', points: 720, weekly: 80, streak: 5, country: 'México', city: 'Monterrey' },
];

const insUser = db.prepare(`
  INSERT INTO users (name, email, password_hash, initials, avatar_seed, status, country, city, streak_days, last_active_on, onboarded_at, consent_at, created_at)
  VALUES (@name, @email, @password_hash, @initials, @avatar_seed, 'active', @country, @city, @streak, @last_active_on, @onboarded_at, @consent_at, @created_at)
  ON CONFLICT(email) DO NOTHING
`);
const insLedger = db.prepare(
  'INSERT INTO points_ledger (user_id, delta, reason, ref_type, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const ledgerCount = db.prepare('SELECT COUNT(*) c FROM points_ledger WHERE user_id = ?');

for (const u of USERS) {
  insUser.run({
    name: u.name, email: u.email, password_hash: PASSWORD_HASH,
    initials: u.initials, avatar_seed: u.initials.toLowerCase(),
    country: u.country, city: u.city, streak: u.streak,
    last_active_on: yesterdayStr,
    onboarded_at: daysAgo(20), consent_at: daysAgo(20),
    created_at: daysAgo(20),
  });
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(u.email);
  if (ledgerCount.get(row.id).c === 0) {
    // base histórico (fuera de la semana) + delta de esta semana
    insLedger.run(row.id, u.points - u.weekly, 'seed', null, null, daysAgo(10));
    insLedger.run(row.id, u.weekly, 'seed', null, null, hoursAgo(6));
  }
  recomputeUserPoints(row.id);
}

const joshua = db.prepare('SELECT * FROM users WHERE email = ?').get('joshua@sensolab.dev');

// preferencias por defecto para todos
const insPrefs = db.prepare('INSERT INTO preferences (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING');
for (const r of db.prepare('SELECT id FROM users').all()) insPrefs.run(r.id);

// ---------------------------------------------------------------------------
// Perfil sensorial de todos (demo) — Joshua con un dato que NO bloquea nada
// ---------------------------------------------------------------------------
const insProfile = db.prepare(`
  INSERT INTO user_sensory_profile
    (user_id, dob, country, city, dietary_restrictions, allergies, sensory_prefs_json, smoker, notes, completed_at)
  VALUES (@user_id, @dob, @country, @city, @dietary_restrictions, @allergies, @sensory_prefs_json, @smoker, @notes, @completed_at)
  ON CONFLICT(user_id) DO NOTHING
`);
for (const u of USERS) {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(u.email);
  insProfile.run({
    user_id: row.id, dob: '1998-05-14', country: u.country, city: u.city,
    dietary_restrictions: '', allergies: '',
    sensory_prefs_json: JSON.stringify({ intensidad: 'media', formato: 'presencial' }),
    smoker: 0, notes: null, completed_at: daysAgo(20),
  });
}

const insConsent = db.prepare(
  "INSERT INTO consents (user_id, kind, granted_at) VALUES (?, 'datos', ?) ON CONFLICT DO NOTHING"
);
for (const r of db.prepare('SELECT id FROM users').all()) insConsent.run(r.id, daysAgo(20));

// ---------------------------------------------------------------------------
// Estado de sesiones de Joshua
// ---------------------------------------------------------------------------
const upsertUS = db.prepare(`
  INSERT INTO user_sessions (user_id, session_id, status, progress_pct, points_awarded, started_at, completed_at)
  VALUES (@user_id, @session_id, @status, @progress_pct, @points_awarded, @started_at, @completed_at)
  ON CONFLICT(user_id, session_id) DO UPDATE SET
    status = excluded.status, progress_pct = excluded.progress_pct,
    points_awarded = excluded.points_awarded, completed_at = excluded.completed_at
`);
upsertUS.run({
  user_id: joshua.id, session_id: sessBySlug('textura-tactil').id,
  status: 'in_progress', progress_pct: 60, points_awarded: 0,
  started_at: hoursAgo(1), completed_at: null,
});
upsertUS.run({
  user_id: joshua.id, session_id: sessBySlug('prueba-olfativa').id,
  status: 'completed', progress_pct: 100, points_awarded: 40,
  started_at: daysAgo(2), completed_at: daysAgo(2),
});

// El +40 de la olfativa vive como fila de sesión en el ledger; ajusta el seed
// genérico de Joshua para que el total siga cuadrando (720, semana 80).
if (db.prepare("SELECT COUNT(*) c FROM points_ledger WHERE user_id = ? AND reason = 'session'").get(joshua.id).c === 0) {
  db.exec('BEGIN');
  db.prepare("DELETE FROM points_ledger WHERE user_id = ? AND reason = 'seed'").run(joshua.id);
  insLedger.run(joshua.id, 720 - 80, 'seed', null, null, daysAgo(10));
  insLedger.run(joshua.id, 40, 'session', 'session', sessBySlug('prueba-olfativa').id, hoursAgo(3));
  insLedger.run(joshua.id, 40, 'seed', null, null, hoursAgo(3));
  db.exec('COMMIT');
  recomputeUserPoints(joshua.id);
}

// Insignias de Joshua (las que su estado justifica)
const linkBadge = db.prepare(`
  INSERT INTO user_badges (user_id, badge_id, earned_at)
  SELECT ?, id, ? FROM badges WHERE slug = ? ON CONFLICT DO NOTHING
`);
for (const slug of ['primer-cata', 'racha-5', 'explorador-olfativo']) {
  linkBadge.run(joshua.id, daysAgo(3), slug);
}

// ---------------------------------------------------------------------------
// Actividad + notificaciones de Joshua (sólo si no hay nada)
// ---------------------------------------------------------------------------
if (db.prepare('SELECT COUNT(*) c FROM activity WHERE user_id = ?').get(joshua.id).c === 0) {
  const addA = db.prepare('INSERT INTO activity (user_id, text_html, created_at) VALUES (?, ?, ?)');
  addA.run(joshua.id, 'Completaste <b>Prueba Olfativa</b>', hoursAgo(3));
  addA.run(joshua.id, 'Subiste al <b>Nivel 2</b>', hoursAgo(26));
  addA.run(joshua.id, 'Ganaste la insignia <b>Racha 5 días</b>', hoursAgo(72));

  const addN = db.prepare('INSERT INTO notifications (user_id, icon, tipo, title, created_at) VALUES (?, ?, ?, ?, ?)');
  addN.run(joshua.id, 'clock',  'session',   'Nueva sesión disponible: Percepción Visual', hoursAgo(2));
  addN.run(joshua.id, 'bolt',   'level',     'Subiste al Nivel 2 · Catador', hoursAgo(26));
  addN.run(joshua.id, 'users',  'community', 'María R. te superó en el ranking semanal', hoursAgo(50));
  addN.run(joshua.id, 'shield', 'badge',     'Ganaste la insignia Racha 5 días', hoursAgo(72));
}

const total = db.prepare('SELECT COUNT(*) c FROM users').get().c;
console.log(`✓ seed completo — ${total} usuarios, ${CATALOG.length} sesiones, ${BADGES.length} insignias.`);
console.log('  Login demo:  joshua@sensolab.dev  /  demo1234   (OTP en dev: 000000)');
