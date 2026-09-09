// ===========================================================================
//  remote-mock.js — API falsa en el navegador para "Pruebas sensoriales a
//  distancia". Implementa el contrato /api/remote/* del spec sin servidor.
//
//  Persiste en localStorage (clave por usuario) para que el flujo sobreviva
//  recargas. Cuando exista el backend real:
//    window.SENSOLAB_REMOTE_MOCK = false   → remote.js llama a /api/remote/*
//  y este archivo se puede borrar.
//
//  Expone: window.SLRemoteMock.call(path, { method, body }) -> Promise<data>
//  Lanza  { status, data:{ error } }  igual que el api() real de index.html.
// ===========================================================================
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  //  Catálogo remoto. Dos sesiones para mostrar variedad de evidencia.
  //  minDurationSec: mínimo server-enforced, igual que en presencial.
  // -------------------------------------------------------------------------
  const REMOTE_CATALOG = [
    {
      slug: 'cata-remota-umami',
      name: 'Cata Umami a distancia',
      description: 'Kit de 5 caldos · perfil umami',
      sense: 'taste',
      points: 70,
      durationMin: 12,
      minDurationSec: 300,
      requiredLevel: 2,
      kitSku: 'KIT-UMAMI-5',
      evidenceKind: 'foto',        // qué se pide como media de evidencia
      checklist: [
        'Estoy en una sala con luz neutra y sin olores fuertes.',
        'Silencié notificaciones y no habrá interrupciones 15 min.',
        'Tengo agua a temperatura ambiente para enjuagar.',
        'El kit está sellado y a temperatura ambiente.',
      ],
      steps: [
        'Destapa las muestras A–E en orden, sin enjuagar entre las dos primeras.',
        'Puntúa intensidad umami del 1 al 5 en cada una.',
        'Toma UNA foto de las 5 muestras destapadas junto a tu hoja de respuestas.',
      ],
    },
    {
      slug: 'aroma-remoto-citrico',
      name: 'Aroma Cítrico a distancia',
      description: 'Tira olfativa · fragancia cítrica',
      sense: 'smell',
      points: 55,
      durationMin: 9,
      minDurationSec: 240,
      requiredLevel: 2,
      kitSku: 'KIT-CITRICO-1',
      evidenceKind: 'audio',
      checklist: [
        'Ventilé la habitación y no hay comida ni perfume cerca.',
        'No he usado crema de manos ni fumado en la última hora.',
        'Silencié notificaciones y no habrá interrupciones 10 min.',
      ],
      steps: [
        'Agita la tira 3 veces y huele a 2 cm durante 4 segundos.',
        'Espera 30 s y repite. Anota las tres familias que percibas.',
        'Graba una nota de voz de 20–40 s describiendo el aroma y su evolución.',
      ],
    },
  ];

  // -------------------------------------------------------------------------
  //  Heurística de integridad — DECISIÓN DE NEGOCIO, pensada para ajustarse.
  //  Cambia los pesos/umbrales aquí; el resto del flujo no necesita tocarse.
  // -------------------------------------------------------------------------
  const SCORING = {
    start: 100,
    penalties: {
      duracionCorta: 40,          // duracion_real_seg < minDurationSec
      mediaFaltante: 50,          // sin submission_media_url
      confirmacionPrematura: 25,  // start < 60 s tras confirmar y tracking != entregado
      geoInconsistente: 15,       // geoloc consentida y lejos de lo declarado
    },
    umbralAuto: 75,               // score >= 75  -> auto_ok
    umbralManual: 40,             // 40..74 -> manual_pending ; <40 -> manual + flag alta
  };

  // -------------------------------------------------------------------------
  //  Persistencia
  // -------------------------------------------------------------------------
  const STORE_VERSION = 1;
  const keyFor = () => {
    const me = (window.SL && window.SL.state && window.SL.state.me) || {};
    return `sensolab_remote_mock_v${STORE_VERSION}_${me.id || 'anon'}`;
  };

  function seededQueue() {
    // Intentos de OTROS usuarios ya en revisión, para que un reviewer tenga
    // algo real que decidir en la demo.
    const now = Date.now();
    return [
      {
        id: 9001, slug: 'cata-remota-umami', session_attempt_id: 'sa-ext-1',
        usuario: 'Marisol Vega', iniciales: 'MV',
        setup_photo_url: 'mock://setup/marisol.jpg',
        submission_media_url: 'mock://evidence/marisol.jpg',
        started_at: new Date(now - 21 * 60000).toISOString(),
        submitted_at: new Date(now - 12 * 60000).toISOString(),
        duracion_real_seg: 540,
        integrity_score: 58,
        estado_validacion: 'manual_pending',
        respuestas: { A: 4, B: 2, C: 5, D: 3, E: 4, nota: 'La C domina, muy salada.' },
        geolocalizacion: null,
      },
      {
        id: 9002, slug: 'aroma-remoto-citrico', session_attempt_id: 'sa-ext-2',
        usuario: 'Diego Fuentes', iniciales: 'DF',
        setup_photo_url: 'mock://setup/diego.jpg',
        submission_media_url: null,
        started_at: new Date(now - 9 * 60000).toISOString(),
        submitted_at: new Date(now - 6 * 60000).toISOString(),
        duracion_real_seg: 110,
        integrity_score: 22,
        estado_validacion: 'manual_pending',
        respuestas: { familias: ['cítrico', 'verde'], nota: 'Se apagó rápido.' },
        geolocalizacion: null,
      },
    ];
  }

  function freshStore() {
    return {
      version: STORE_VERSION,
      role: 'member',            // 'member' | 'reviewer' — toggle desde la UI
      shipments: {},             // slug -> shipment
      attempts: {},              // slug -> attempt (el intento vigente del usuario)
      flags: [],                 // integrity_flags de los intentos del usuario
      queueExtra: seededQueue(), // intentos de otros usuarios para el reviewer
    };
  }

  let _store = null;
  function store() {
    if (_store) return _store;
    try {
      const raw = localStorage.getItem(keyFor());
      _store = raw ? JSON.parse(raw) : freshStore();
      if (_store.version !== STORE_VERSION) _store = freshStore();
    } catch {
      _store = freshStore();
    }
    return _store;
  }
  function save() {
    try { localStorage.setItem(keyFor(), JSON.stringify(store())); } catch { /* modo privado */ }
  }

  // -------------------------------------------------------------------------
  //  Simulación de logística: el envío avanza por el tiempo transcurrido.
  //  pendiente --(4s)--> enviado --(10s)--> entregado --(confirm)--> confirmado
  // -------------------------------------------------------------------------
  const SHIP_TO_SENT_MS = 4000;
  const SENT_TO_DELIVERED_MS = 10000;

  function advanceShipment(sh) {
    if (!sh || sh.estado === 'confirmado') return sh;
    const age = Date.now() - new Date(sh._requested_at).getTime();
    let estado = 'pendiente';
    if (age >= SHIP_TO_SENT_MS) estado = 'enviado';
    if (age >= SHIP_TO_SENT_MS + SENT_TO_DELIVERED_MS) estado = 'entregado';
    if (estado !== sh.estado) {
      sh.estado = estado;
      if (estado === 'enviado' && !sh.fecha_envio) sh.fecha_envio = new Date().toISOString();
      if (estado === 'entregado' && !sh.fecha_entrega) sh.fecha_entrega = new Date().toISOString();
    }
    return sh;
  }

  const genTracking = () =>
    'SL' + Math.random().toString(36).slice(2, 8).toUpperCase() + 'MX';
  const nowISO = () => new Date().toISOString();
  const fail = (status, error) => { throw { status, data: { error } }; };

  function catalogBySlug(slug) {
    return REMOTE_CATALOG.find((s) => s.slug === slug);
  }

  function userLevel() {
    const me = (window.SL && window.SL.state && window.SL.state.me) || {};
    return me.level || 1;
  }

  // -------------------------------------------------------------------------
  //  Vista pública de una sesión remota (catálogo + estado del usuario)
  // -------------------------------------------------------------------------
  function sessionView(cat) {
    const s = store();
    const sh = advanceShipment(s.shipments[cat.slug]);
    const at = s.attempts[cat.slug];
    const eligible = userLevel() >= cat.requiredLevel;

    let stage = 'eligible';                       // eligible | kit | confirm | ready | in_progress | submitted | done | rejected
    if (!eligible) stage = 'locked';
    else if (!sh) stage = 'kit';
    else if (sh.estado !== 'confirmado') stage = 'confirm';
    else if (!at) stage = 'ready';
    else if (at.estado_validacion === 'manual_pending') stage = 'submitted';
    else if (at.estado_validacion === 'rechazado') stage = 'rejected';
    else if (at.estado_validacion === 'auto_ok' || at.estado_validacion === 'aprobado') stage = 'done';
    else if (at.started_at && !at.submitted_at) stage = 'in_progress';

    return {
      slug: cat.slug,
      name: cat.name,
      description: cat.description,
      sense: cat.sense,
      points: cat.points,
      durationMin: cat.durationMin,
      minDurationSec: cat.minDurationSec,
      requiredLevel: cat.requiredLevel,
      kitSku: cat.kitSku,
      evidenceKind: cat.evidenceKind,
      checklist: cat.checklist,
      steps: cat.steps,
      eligible,
      stage,
      shipment: sh
        ? {
            id: sh.id, estado: sh.estado, tracking_code: sh.tracking_code,
            direccion_envio: sh.direccion_envio, fecha_envio: sh.fecha_envio || null,
            fecha_entrega: sh.fecha_entrega || null,
            fecha_confirmacion: sh.fecha_confirmacion || null,
          }
        : null,
      attempt: at
        ? {
            id: at.id, estado_validacion: at.estado_validacion,
            integrity_score: at.integrity_score,
            started_at: at.started_at, submitted_at: at.submitted_at,
            review_nota: at.review_nota || null,
          }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  //  Cálculo de integridad + flags
  // -------------------------------------------------------------------------
  function scoreAttempt(cat, at, sh) {
    const P = SCORING.penalties;
    let score = SCORING.start;
    const flags = [];
    const addFlag = (tipo, severidad) =>
      flags.push({
        id: Math.floor(Math.random() * 1e6),
        remote_attempt_id: at.id, slug: cat.slug, tipo, severidad, resuelto_por: null,
      });

    if (at.duracion_real_seg < cat.minDurationSec) {
      score -= P.duracionCorta;
      addFlag('duracion_sospechosa', 'alta');
    }
    if (!at.submission_media_url) {
      score -= P.mediaFaltante;
      addFlag('media_faltante', 'alta');
    }
    if (sh && sh.fecha_confirmacion) {
      const gap = new Date(at.started_at).getTime() - new Date(sh.fecha_confirmacion).getTime();
      if (gap < 60000 && !sh._delivered_before_confirm) {
        score -= P.confirmacionPrematura;
        addFlag('confirmacion_prematura', 'media');
      }
    }
    if (at.geolocalizacion && at.geolocalizacion.inconsistente) {
      score -= P.geoInconsistente;
      addFlag('geolocalizacion_inconsistente', 'baja');
    }

    score = Math.max(0, Math.min(100, score));
    let estado_validacion;
    if (score >= SCORING.umbralAuto) estado_validacion = 'auto_ok';
    else estado_validacion = 'manual_pending';           // nunca rechazo automático
    if (score < SCORING.umbralManual) addFlag('score_muy_bajo', 'alta');

    return { score, estado_validacion, flags };
  }

  // -------------------------------------------------------------------------
  //  Router
  // -------------------------------------------------------------------------
  async function call(path, { method = 'GET', body } = {}) {
    await new Promise((r) => setTimeout(r, 120));   // latencia simulada
    const s = store();

    // GET /remote/sessions/eligible
    if (method === 'GET' && path === '/remote/sessions/eligible') {
      const out = REMOTE_CATALOG.map(sessionView);
      save();
      return { sessions: out, role: s.role };
    }

    // POST /remote/sessions/:slug/request-kit
    let m = path.match(/^\/remote\/sessions\/([^/]+)\/request-kit$/);
    if (m && method === 'POST') {
      const cat = catalogBySlug(m[1]);
      if (!cat) fail(404, 'Sesión remota no encontrada.');
      if (userLevel() < cat.requiredLevel) fail(403, `Necesitas Nivel ${cat.requiredLevel}.`);
      if (s.shipments[cat.slug]) fail(409, 'Ya solicitaste el kit de esta sesión.');
      const dir = (body && body.direccion_envio || '').trim();
      if (dir.length < 12) fail(400, 'Escribe una dirección de envío completa.');
      s.shipments[cat.slug] = {
        id: Math.floor(Math.random() * 9000) + 1000,
        sku: cat.kitSku,
        estado: 'pendiente',
        tracking_code: genTracking(),
        direccion_envio: dir,
        _requested_at: nowISO(),
        fecha_envio: null, fecha_entrega: null, fecha_confirmacion: null,
      };
      save();
      return { shipment: sessionView(cat).shipment };
    }

    // POST /remote/shipments/:id/confirm
    m = path.match(/^\/remote\/shipments\/(\d+)\/confirm$/);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      const entry = Object.entries(s.shipments).find(([, sh]) => sh.id === id);
      if (!entry) fail(404, 'Envío no encontrado.');
      const [slug, sh] = entry;
      advanceShipment(sh);
      // ¿el proveedor ya marcaba 'entregado' cuando el usuario confirmó?
      sh._delivered_before_confirm = sh.estado === 'entregado';
      sh.estado = 'confirmado';
      sh.fecha_confirmacion = nowISO();
      save();
      return { shipment: sessionView(catalogBySlug(slug)).shipment };
    }

    // POST /remote/sessions/:slug/start
    m = path.match(/^\/remote\/sessions\/([^/]+)\/start$/);
    if (m && method === 'POST') {
      const cat = catalogBySlug(m[1]);
      if (!cat) fail(404, 'Sesión remota no encontrada.');
      const sh = s.shipments[cat.slug];
      if (!sh || sh.estado !== 'confirmado') {
        fail(403, 'Confirma la recepción del kit antes de iniciar.');
      }
      const checklist = (body && body.checklist) || {};
      const allChecked = cat.checklist.every((_, i) => checklist[i] === true);
      if (!allChecked) fail(400, 'Marca todos los puntos del checklist.');
      if (!(body && body.setup_photo_url)) fail(400, 'Falta la foto del setup.');

      s.attempts[cat.slug] = {
        id: Math.floor(Math.random() * 9000) + 1000,
        session_attempt_id: 'sa-' + Date.now(),
        shipment_id: sh.id,
        setup_photo_url: body.setup_photo_url,
        submission_media_url: null,
        checklist,
        respuestas: null,
        geolocalizacion: null,
        started_at: nowISO(),         // timestamp "server-side"
        submitted_at: null,
        duracion_real_seg: null,
        integrity_score: null,
        estado_validacion: null,
      };
      save();
      return { attempt: sessionView(cat).attempt, startedAt: s.attempts[cat.slug].started_at };
    }

    // POST /remote/sessions/:slug/submit
    m = path.match(/^\/remote\/sessions\/([^/]+)\/submit$/);
    if (m && method === 'POST') {
      const cat = catalogBySlug(m[1]);
      if (!cat) fail(404, 'Sesión remota no encontrada.');
      const at = s.attempts[cat.slug];
      if (!at || !at.started_at) fail(409, 'Esta sesión no está iniciada.');
      if (at.submitted_at) fail(409, 'Ya enviaste esta sesión.');

      at.submitted_at = nowISO();
      at.submission_media_url = (body && body.submission_media_url) || null;
      at.respuestas = (body && body.respuestas) || null;
      at.geolocalizacion = (body && body.geolocalizacion) || null;
      at.duracion_real_seg = Math.round(
        (new Date(at.submitted_at).getTime() - new Date(at.started_at).getTime()) / 1000
      );

      const sh = s.shipments[cat.slug];
      const { score, estado_validacion, flags } = scoreAttempt(cat, at, sh);
      at.integrity_score = score;
      at.estado_validacion = estado_validacion;
      s.flags = s.flags.filter((f) => f.remote_attempt_id !== at.id).concat(flags);

      let awarded = 0;
      if (estado_validacion === 'auto_ok') awarded = cat.points;
      save();
      return {
        attempt: sessionView(cat).attempt,
        integrity_score: score,
        estado_validacion,
        awarded,
        flags: flags.map((f) => ({ tipo: f.tipo, severidad: f.severidad })),
      };
    }

    // GET /remote/review-queue   (solo reviewer)
    if (method === 'GET' && path === '/remote/review-queue') {
      if (s.role !== 'reviewer') fail(403, 'Solo un revisor puede ver la cola.');
      const mine = Object.entries(s.attempts)
        .filter(([, at]) => at.estado_validacion === 'manual_pending')
        .map(([slug, at]) => ({
          id: at.id, slug, session_attempt_id: at.session_attempt_id,
          usuario: 'Tú (demo)', iniciales: (window.SL.state.me || {}).initials || 'SL',
          setup_photo_url: at.setup_photo_url,
          submission_media_url: at.submission_media_url,
          started_at: at.started_at, submitted_at: at.submitted_at,
          duracion_real_seg: at.duracion_real_seg,
          integrity_score: at.integrity_score,
          estado_validacion: at.estado_validacion,
          respuestas: at.respuestas, geolocalizacion: at.geolocalizacion,
        }));
      const all = mine.concat(s.queueExtra.filter((q) => q.estado_validacion === 'manual_pending'));
      const withFlags = all.map((a) => ({
        ...a,
        catalog: pickCatalog(a.slug),
        flags: flagsForQueueItem(a),
      }));
      return { queue: withFlags };
    }

    // POST /remote/review/:attemptId
    m = path.match(/^\/remote\/review\/(\d+)$/);
    if (m && method === 'POST') {
      if (s.role !== 'reviewer') fail(403, 'Solo un revisor puede decidir.');
      const id = Number(m[1]);
      const decision = body && body.decision;
      if (!['aprobado', 'rechazado'].includes(decision)) fail(400, 'Decisión inválida.');

      // ¿es un intento del propio usuario?
      const mineEntry = Object.entries(s.attempts).find(([, at]) => at.id === id);
      let slug = null, points = 0;
      if (mineEntry) {
        const [sl, at] = mineEntry;
        at.estado_validacion = decision;
        at.review_nota = (body && body.nota) || null;
        at.reviewed_by = 'reviewer-demo';
        slug = sl;
        points = decision === 'aprobado' ? pickCatalog(sl).points : 0;
        s.flags.forEach((f) => { if (f.remote_attempt_id === id) f.resuelto_por = 'reviewer-demo'; });
      } else {
        const q = s.queueExtra.find((x) => x.id === id);
        if (!q) fail(404, 'Intento no encontrado.');
        q.estado_validacion = decision;
      }
      save();
      return { ok: true, decision, slug, awarded: points };
    }

    fail(404, 'Ruta remota no encontrada: ' + method + ' ' + path);
  }

  function pickCatalog(slug) {
    return catalogBySlug(slug) || { points: 0, name: slug, minDurationSec: 0, evidenceKind: 'foto' };
  }

  function flagsForQueueItem(a) {
    // Para intentos propios usamos los flags guardados; para los sembrados,
    // derivamos algo coherente con su score/datos.
    const s = store();
    const own = s.flags.filter((f) => f.remote_attempt_id === a.id);
    if (own.length) return own.map((f) => ({ tipo: f.tipo, severidad: f.severidad }));
    const out = [];
    const cat = pickCatalog(a.slug);
    if (a.duracion_real_seg != null && a.duracion_real_seg < cat.minDurationSec) {
      out.push({ tipo: 'duracion_sospechosa', severidad: 'alta' });
    }
    if (!a.submission_media_url) out.push({ tipo: 'media_faltante', severidad: 'alta' });
    if (a.integrity_score != null && a.integrity_score < SCORING.umbralManual) {
      out.push({ tipo: 'score_muy_bajo', severidad: 'alta' });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  //  API pública del mock
  // -------------------------------------------------------------------------
  window.SLRemoteMock = {
    call,
    // helpers que la UI usa directamente (no son endpoints del spec):
    getRole: () => store().role,
    setRole: (r) => { store().role = r === 'reviewer' ? 'reviewer' : 'member'; save(); },
    reset: () => { _store = freshStore(); save(); },
    SCORING,
  };
})();
