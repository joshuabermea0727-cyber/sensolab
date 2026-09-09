// ===========================================================================
//  remote.js — UI del flujo "Pruebas sensoriales a distancia".
//
//  Depende de window.SL (puente expuesto por index.html) y de window.pushView /
//  window.popView. Habla con remote-mock.js salvo que
//  window.SENSOLAB_REMOTE_MOCK === false, en cuyo caso llama a /api/remote/*.
// ===========================================================================
(function () {
  'use strict';

  const USE_MOCK = window.SENSOLAB_REMOTE_MOCK !== false;
  const $ = (id) => document.getElementById(id);
  const SL = window.SL;

  // -----------------------------------------------------------------------
  //  Capa de red: mock o backend real, misma forma de respuesta/errores.
  // -----------------------------------------------------------------------
  async function rcall(path, opts = {}) {
    if (USE_MOCK) {
      try {
        return await window.SLRemoteMock.call(path, opts);
      } catch (e) {
        const err = new Error((e && e.data && e.data.error) || 'Error remoto');
        err.status = e && e.status;
        err.data = e && e.data;
        throw err;
      }
    }
    return SL.api('/remote' + path, opts);
  }

  const role = {
    get: () => (USE_MOCK ? window.SLRemoteMock.getRole() : (SL.state.me && SL.state.me.role) || 'member'),
    set: (r) => { if (USE_MOCK) window.SLRemoteMock.setRole(r); },
  };

  // -----------------------------------------------------------------------
  //  Estado local del módulo
  // -----------------------------------------------------------------------
  const R = {
    sessions: [],
    current: null,        // sesión remota elegida (objeto del catálogo+estado)
    checklist: {},        // índice -> bool
    setupPhotoUrl: null,
    evidenceUrl: null,
    startedAt: null,
    timerId: null,
    shipPollId: null,
  };

  const ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  };

  const STAGE_LABEL = {
    locked: 'BLOQUEADA', kit: 'PIDE KIT', confirm: 'EN CAMINO',
    ready: 'LISTA', in_progress: 'EN CURSO', submitted: 'EN REVISIÓN',
    done: 'ACREDITADA', rejected: 'RECHAZADA',
  };
  const mmss = (secs) => {
    const s = Math.max(0, Math.floor(secs));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const esc = (s) => SL.escapeHtml(s);

  // =======================================================================
  //  HUB
  // =======================================================================
  async function openHub() {
    stopTimer();
    try {
      const data = await rcall('/remote/sessions/eligible');
      R.sessions = data.sessions || [];
    } catch (e) {
      SL.showToast(e.message, 'err');
      R.sessions = [];
    }
    renderHub();
    window.pushView('view-remoto');
  }

  function renderHub() {
    // Franja de revisor
    const strip = $('remotoReviewStrip');
    const isReviewer = role.get() === 'reviewer';
    strip.hidden = false;
    strip.innerHTML = `
      <div class="role-strip">
        <div class="rs-text">Modo <b>${isReviewer ? 'revisor' : 'participante'}</b>${
          isReviewer ? ' · puedes validar intentos ajenos' : ''}</div>
        <div class="toggle${isReviewer ? ' on' : ''}" id="roleToggle"></div>
      </div>
      ${isReviewer ? `
      <div class="session-card is-actionable" id="openQueueCard" style="opacity:1;transform:none;">
        <div class="sense-icon icon-sight">${SL.strokeSvg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>')}</div>
        <div class="session-body">
          <div class="name">Cola de revisión</div>
          <div class="desc">Intentos en rango ambiguo</div>
        </div>
        <div class="status-chip chip-progress">ABRIR</div>
      </div>` : ''}
    `;
    $('roleToggle').addEventListener('click', () => {
      role.set(isReviewer ? 'member' : 'reviewer');
      renderHub();
    });
    const oq = $('openQueueCard');
    if (oq) oq.addEventListener('click', openQueue);

    // Lista de sesiones
    const host = $('remotoList');
    if (!R.sessions.length) {
      host.innerHTML = '<div class="empty-note">No hay sesiones a distancia disponibles.</div>';
      return;
    }
    host.innerHTML = R.sessions.map((s, i) => {
      const actionable = s.stage !== 'locked';
      return `
        <div class="session-card${actionable ? ' is-actionable' : ''}" data-slug="${s.slug}"
             style="animation-delay:${(0.02 + i * 0.05).toFixed(2)}s">
          <div class="sense-icon icon-${s.sense}">${SL.strokeSvg(sensePath(s.sense))}</div>
          <div class="session-body">
            <div class="name">${esc(s.name)}</div>
            <div class="desc">${esc(s.description)} · +${s.points} pts</div>
          </div>
          <div class="r-stagechip r-stage-${s.stage}">${STAGE_LABEL[s.stage] || s.stage.toUpperCase()}</div>
        </div>`;
    }).join('');
    host.querySelectorAll('.session-card.is-actionable').forEach((el) => {
      el.addEventListener('click', () => routeSession(el.dataset.slug));
    });
  }

  function sensePath(sense) {
    return ({
      taste: '<path d="M6 3c0 4-3 5-3 9a6 6 0 0 0 12 0c0-1.5-.5-2.5-1.2-3.5"/><path d="M13 3c0 3-2 4.5-2 7"/>',
      smell: '<path d="M16 3c1 2 1 4-.5 6M19 6c1.3 1.7 1.3 3.6 0 5.4"/><path d="M9 4a3 3 0 0 0-3 3v6a6 6 0 0 0 12 0"/>',
      sound: '<path d="M3 10v4"/><path d="M7 6v12"/><path d="M11 3v18"/><path d="M15 7v10"/><path d="M19 10v4"/>',
      touch: '<path d="M9 12V6a2 2 0 1 1 4 0"/><path d="M13 6a2 2 0 1 1 4 0v5"/>',
      sight: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    })[sense] || '';
  }

  // Decide a qué pantalla llevar según la etapa de la sesión.
  function routeSession(slug) {
    const s = R.sessions.find((x) => x.slug === slug);
    if (!s || s.stage === 'locked') {
      SL.showToast(`Necesitas Nivel ${s ? s.requiredLevel : '?'} para esta sesión.`, 'err');
      return;
    }
    R.current = s;
    if (s.stage === 'kit' || s.stage === 'confirm') return renderKit();
    if (s.stage === 'ready') { R.checklist = {}; R.setupPhotoUrl = null; return renderChecklist(); }
    if (s.stage === 'in_progress') { R.startedAt = s.attempt && s.attempt.started_at; return renderActive(); }
    if (s.stage === 'submitted' || s.stage === 'done' || s.stage === 'rejected') {
      return renderResult(s.attempt);
    }
  }

  // =======================================================================
  //  KIT + ENVÍO
  // =======================================================================
  function renderKit() {
    const s = R.current;
    $('kitTitle').textContent = s.name;
    const hasShip = !!s.shipment;
    $('kitRequestBlock').hidden = hasShip;
    $('kitTrackBlock').hidden = !hasShip;

    if (!hasShip) {
      $('kitSub').textContent = `Kit ${s.kitSku} · se envía a tu domicilio.`;
      $('kitAddr').value = '';
      $('kitRequestBtn').disabled = false;
      $('kitRequestBtn').textContent = 'Solicitar kit';
      $('kitRequestBtn').onclick = requestKit;
    } else {
      renderTracker(s.shipment);
      startShipPoll();
    }
    SL.showView('view-remoto-kit');
  }

  async function requestKit() {
    const dir = $('kitAddr').value.trim();
    if (dir.length < 12) { SL.showToast('Escribe una dirección completa.', 'err'); return; }
    const btn = $('kitRequestBtn');
    btn.disabled = true; btn.textContent = 'Solicitando…';
    try {
      await rcall(`/remote/sessions/${R.current.slug}/request-kit`, {
        method: 'POST', body: { direccion_envio: dir },
      });
      await refreshCurrent();
      renderKit();
      SL.showToast('Kit solicitado. Te avisamos al enviarlo.');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Solicitar kit';
      SL.showToast(e.message, 'err');
    }
  }

  const SHIP_STEPS = [
    { key: 'pendiente', title: 'Solicitud recibida', meta: 'Preparando el kit' },
    { key: 'enviado', title: 'Kit enviado', meta: 'En tránsito' },
    { key: 'entregado', title: 'Entregado', meta: 'Según el proveedor' },
    { key: 'confirmado', title: 'Recepción confirmada', meta: 'Por ti, en la app' },
  ];

  function renderTracker(sh) {
    const order = SHIP_STEPS.map((x) => x.key);
    const curIdx = order.indexOf(sh.estado);
    $('kitTracker').innerHTML = SHIP_STEPS.map((st, i) => {
      const cls = i < curIdx ? 'is-done' : i === curIdx ? 'is-current' : 'is-pending';
      let meta = st.meta;
      if (st.key === 'enviado' && sh.fecha_envio) meta = `Guía ${sh.tracking_code}`;
      if (st.key === 'confirmado' && sh.fecha_confirmacion) meta = SL.relTime(sh.fecha_confirmacion);
      return `<div class="ship-step ${cls}">
        <div class="ship-dot"></div>
        <div><div class="ss-title">${st.title}</div><div class="ss-meta">${esc(meta)}</div></div>
      </div>`;
    }).join('');

    const confirmBtn = $('kitConfirmBtn');
    const note = $('kitConfirmNote');
    if (sh.estado === 'confirmado') {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Recepción confirmada ✓';
      note.textContent = 'Ya puedes iniciar la sesión desde el hub.';
      stopShipPoll();
    } else if (sh.estado === 'pendiente') {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Confirmar recepción';
      note.textContent = 'Espera a que el kit salga a reparto.';
    } else {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmar recepción';
      note.textContent = sh.estado === 'entregado'
        ? 'Confirma solo con el kit contigo y sin abrir.'
        : 'El proveedor aún no marca "entregado". Confirmar ahora puede afectar tu integrity_score.';
      confirmBtn.onclick = () => confirmShipment(sh.id);
    }
  }

  async function confirmShipment(id) {
    const btn = $('kitConfirmBtn');
    btn.disabled = true; btn.textContent = 'Confirmando…';
    try {
      await rcall(`/remote/shipments/${id}/confirm`, { method: 'POST' });
      await refreshCurrent();
      SL.showToast('Recepción confirmada. Sesión habilitada.');
      renderHub();
      SL.showView('view-remoto');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Confirmar recepción';
      SL.showToast(e.message, 'err');
    }
  }

  function startShipPoll() {
    stopShipPoll();
    R.shipPollId = setInterval(async () => {
      if (!$('view-remoto-kit').classList.contains('active')) { stopShipPoll(); return; }
      try {
        await refreshCurrent();
        if (R.current && R.current.shipment) renderTracker(R.current.shipment);
      } catch { /* silencio */ }
    }, 2000);
  }
  function stopShipPoll() { if (R.shipPollId) { clearInterval(R.shipPollId); R.shipPollId = null; } }

  // =======================================================================
  //  CHECKLIST + FOTO DE SETUP
  // =======================================================================
  function renderChecklist() {
    const s = R.current;
    $('rcTitle').textContent = 'Prepara tu entorno';
    const host = $('rcChecklist');
    host.innerHTML = s.checklist.map((txt, i) => `
      <div class="r-check-row${R.checklist[i] ? ' on' : ''}" data-idx="${i}">
        <div class="r-check-box">${ICON.check}</div>
        <div class="rc-text">${esc(txt)}</div>
      </div>`).join('');
    host.querySelectorAll('.r-check-row').forEach((el) => {
      el.addEventListener('click', () => {
        const i = Number(el.dataset.idx);
        R.checklist[i] = !R.checklist[i];
        el.classList.toggle('on', R.checklist[i]);
        refreshStartBtn();
      });
    });

    const drop = $('rcSetupDrop');
    drop.classList.toggle('has-file', !!R.setupPhotoUrl);
    $('rcSetupTitle').textContent = R.setupPhotoUrl ? 'Foto adjunta ✓' : 'Foto del setup';
    $('rcSetupInput').value = '';
    $('rcSetupInput').onchange = (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      R.setupPhotoUrl = URL.createObjectURL(f);
      drop.classList.add('has-file');
      $('rcSetupTitle').textContent = 'Foto adjunta ✓';
      refreshStartBtn();
    };

    $('rcStartBtn').onclick = startSession;
    refreshStartBtn();
    SL.showView('view-remoto-checklist');
  }

  function refreshStartBtn() {
    const s = R.current;
    const allChecked = s.checklist.every((_, i) => R.checklist[i] === true);
    $('rcStartBtn').disabled = !(allChecked && R.setupPhotoUrl);
  }

  async function startSession() {
    const btn = $('rcStartBtn');
    btn.disabled = true; btn.textContent = 'Iniciando…';
    try {
      const resp = await rcall(`/remote/sessions/${R.current.slug}/start`, {
        method: 'POST',
        body: { checklist: R.checklist, setup_photo_url: R.setupPhotoUrl },
      });
      R.startedAt = resp.startedAt || new Date().toISOString();
      R.evidenceUrl = null;
      await refreshCurrent();
      renderActive();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Iniciar sesión';
      SL.showToast(e.message, 'err');
    }
  }

  // =======================================================================
  //  EJECUCIÓN GUIADA (timer contando hacia arriba, server marca el inicio)
  // =======================================================================
  function renderActive() {
    const s = R.current;
    $('raTitle').textContent = s.name;
    $('raSub').textContent = `Mínimo ${mmss(s.minDurationSec)} · el servidor registró tu inicio.`;
    $('rSteps').innerHTML = s.steps.map((txt, i) => `
      <div class="step"><div class="step-num">${i + 1}</div><p>${esc(txt)}</p></div>`).join('');
    $('rToSubmitBtn').onclick = () => { stopTimer(); renderSubmit(); };

    startTimer();
    SL.showView('view-remoto-activa');
  }

  function startTimer() {
    stopTimer();
    const started = new Date(R.startedAt).getTime();
    const tick = () => {
      const elapsed = (Date.now() - started) / 1000;
      $('rTimerNum').textContent = mmss(elapsed);
      const min = R.current.minDurationSec;
      $('rTimerSub').textContent = elapsed < min
        ? `faltan ${mmss(min - elapsed)} para el mínimo`
        : 'mínimo cumplido';
    };
    tick();
    R.timerId = setInterval(tick, 1000);
  }
  function stopTimer() { if (R.timerId) { clearInterval(R.timerId); R.timerId = null; } }

  // =======================================================================
  //  ENVÍO DE EVIDENCIA + RESPUESTAS
  // =======================================================================
  function renderSubmit() {
    const s = R.current;
    const isAudio = s.evidenceKind === 'audio';
    $('rsSub').textContent = `Evidencia: ${isAudio ? 'nota de voz' : 'foto final'} + tus respuestas.`;
    $('rsMediaTitle').textContent = R.evidenceUrl
      ? 'Evidencia adjunta ✓'
      : (isAudio ? 'Adjuntar nota de voz' : 'Adjuntar foto de evidencia');
    $('rsMediaSub').textContent = isAudio
      ? 'Audio de 20–40 s describiendo el aroma'
      : 'Una foto de las muestras + tu hoja de respuestas';
    const drop = $('rsMediaDrop');
    drop.classList.toggle('has-file', !!R.evidenceUrl);
    const input = $('rsMediaInput');
    input.setAttribute('accept', isAudio ? 'audio/*' : 'image/*');
    input.value = '';
    input.onchange = (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      R.evidenceUrl = URL.createObjectURL(f);
      drop.classList.add('has-file');
      $('rsMediaTitle').textContent = 'Evidencia adjunta ✓';
    };
    $('rsAnswers').value = '';
    $('rsGeo').checked = false;
    $('rsSubmitBtn').onclick = submitAttempt;
    SL.showView('view-remoto-submit');
  }

  async function submitAttempt() {
    const btn = $('rsSubmitBtn');
    btn.disabled = true; btn.textContent = 'Enviando…';
    const body = {
      submission_media_url: R.evidenceUrl || null,
      respuestas: { texto: $('rsAnswers').value.trim() },
      geolocalizacion: $('rsGeo').checked ? { lat: 19.43, lng: -99.13, inconsistente: false } : null,
    };
    try {
      const resp = await rcall(`/remote/sessions/${R.current.slug}/submit`, { method: 'POST', body });
      if (resp.awarded) await SL.creditPoints(resp.awarded, R.current.name);
      await refreshCurrent();
      renderResult({
        estado_validacion: resp.estado_validacion,
        integrity_score: resp.integrity_score,
      }, resp.awarded);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Enviar para validación';
      SL.showToast(e.message, 'err');
    }
  }

  // =======================================================================
  //  RESULTADO
  // =======================================================================
  function renderResult(attempt, awarded) {
    const st = attempt && attempt.estado_validacion;
    const score = attempt && attempt.integrity_score;
    const icon = $('rResIcon');
    const meterWrap = $('rResMeterWrap');
    const note = $('rResNote');

    let cls, glyph, title, body;
    if (st === 'auto_ok' || st === 'aprobado') {
      cls = 'ok'; glyph = ICON.check;
      title = st === 'auto_ok' ? 'Validación automática' : 'Aprobada por revisión';
      body = awarded
        ? `+${awarded} pts acreditados de inmediato.`
        : 'Puntos acreditados.';
    } else if (st === 'manual_pending') {
      cls = 'wait'; glyph = ICON.clock;
      title = 'En revisión manual';
      body = 'Tu intento entró a la cola. Te avisamos cuando haya decisión; los puntos se acreditan solo si se aprueba.';
    } else if (st === 'rechazado') {
      cls = 'no'; glyph = ICON.x;
      title = 'No acreditada';
      body = attempt.review_nota
        || 'El intento no cumplió las condiciones necesarias. No se acreditaron puntos.';
    } else {
      cls = 'wait'; glyph = ICON.clock; title = '—'; body = '';
    }

    icon.className = 'r-result-icon ' + cls;
    icon.innerHTML = glyph;
    $('rResTitle').textContent = title;
    $('rResBody').textContent = body;

    if (typeof score === 'number') {
      meterWrap.hidden = false;
      $('rResMeterFill').style.width = score + '%';
      $('rResMeterVal').textContent = score;
    } else {
      meterWrap.hidden = true;
    }

    if (st === 'manual_pending') {
      note.hidden = false;
      note.textContent = 'El motivo exacto de la revisión no se detalla, para no facilitar el fraude.';
    } else {
      note.hidden = true;
    }
    SL.showView('view-remoto-resultado');
  }

  // =======================================================================
  //  COLA DE REVISIÓN (rol reviewer)
  // =======================================================================
  async function openQueue() {
    let queue = [];
    try {
      const data = await rcall('/remote/review-queue');
      queue = data.queue || [];
    } catch (e) {
      SL.showToast(e.message, 'err');
    }
    renderQueue(queue);
    SL.showView('view-remoto-cola');
  }

  function renderQueue(queue) {
    const host = $('rQueue');
    if (!queue.length) {
      host.innerHTML = '<div class="empty-note">Nada pendiente de revisar. 🎉</div>';
      return;
    }
    host.innerHTML = queue.map((a) => {
      const cat = a.catalog || {};
      const dur = a.duracion_real_seg != null ? mmss(a.duracion_real_seg) : '—';
      const flags = (a.flags || []).map((f) =>
        `<span class="rq-flag ${f.severidad}">${f.tipo}</span>`).join('') || '<span class="rq-flag baja">sin flags</span>';
      const ans = a.respuestas
        ? esc(typeof a.respuestas === 'string' ? a.respuestas : JSON.stringify(a.respuestas))
        : '<i>sin respuestas</i>';
      return `
        <div class="rq-card" data-id="${a.id}">
          <div class="rq-head">
            <div class="rq-avatar">${esc(a.iniciales || '?')}</div>
            <div class="rq-who">
              <div class="rqw-name">${esc(a.usuario || 'Participante')}</div>
              <div class="rqw-meta">${esc(cat.name || a.slug)} · duró ${dur} · min ${mmss(cat.minDurationSec || 0)}</div>
            </div>
            <div class="rq-score">${a.integrity_score != null ? a.integrity_score : '—'}</div>
          </div>
          <div class="rq-media">
            <div class="rq-thumb${a.setup_photo_url ? '' : ' missing'}">${a.setup_photo_url ? 'foto setup' : 'sin setup'}</div>
            <div class="rq-thumb${a.submission_media_url ? '' : ' missing'}">${a.submission_media_url ? 'evidencia' : 'sin evidencia'}</div>
          </div>
          <div class="rq-flags">${flags}</div>
          <div class="rq-answers">${ans}</div>
          <div class="rq-actions">
            <button class="rq-btn reject" data-decision="rechazado">Rechazar</button>
            <button class="rq-btn approve" data-decision="aprobado">Aprobar</button>
          </div>
        </div>`;
    }).join('');

    host.querySelectorAll('.rq-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.rq-card');
        const id = Number(card.dataset.id);
        const decision = btn.dataset.decision;
        card.querySelectorAll('.rq-btn').forEach((b) => (b.disabled = true));
        try {
          const resp = await rcall(`/remote/review/${id}`, { method: 'POST', body: { decision } });
          if (decision === 'aprobado' && resp.awarded) {
            await SL.creditPoints(resp.awarded, (queue.find((q) => q.id === id) || {}).catalog?.name);
          }
          SL.showToast(decision === 'aprobado' ? 'Aprobado · puntos acreditados' : 'Rechazado');
          card.remove();
          if (!host.querySelector('.rq-card')) {
            host.innerHTML = '<div class="empty-note">Nada pendiente de revisar. 🎉</div>';
          }
        } catch (e) {
          card.querySelectorAll('.rq-btn').forEach((b) => (b.disabled = false));
          SL.showToast(e.message, 'err');
        }
      });
    });
  }

  // =======================================================================
  //  Utilidades
  // =======================================================================
  async function refreshCurrent() {
    const data = await rcall('/remote/sessions/eligible');
    R.sessions = data.sessions || [];
    if (R.current) {
      R.current = R.sessions.find((x) => x.slug === R.current.slug) || R.current;
    }
  }

  // Punto de entrada desde la tarjeta en la vista Sesiones.
  window.SLRemoteOpen = openHub;
})();
