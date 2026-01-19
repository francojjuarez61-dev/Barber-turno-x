/*
  Barber Turnos PWA
  REGLA DE ORO (OBLIGATORIA, textual):
  “El rediseño es 100% visual (UI only). No se debe modificar ningún estado, lógica, evento ni flujo funcional de la aplicación.”

  Esta implementación respeta los requisitos funcionales provistos.
*/

(() => {
  'use strict';

  // -----------------------------
  // DOM
  // -----------------------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const el = {
    btnCentral: $('#btnCentral'),
    actionLabel: $('#actionLabel'),
    timerValue: $('#timerValue'),
    etaValue: $('#etaValue'),
    metaValue: $('#metaValue'),
    overtimeTag: $('#overtimeTag'),

    ringProgress: $('#ringProgress'),
    ringCap: $('#ringCap'),
    ringPulse: $('#ringPulse'),

    btnAdd: $('#btnAdd'),
    btnRegistro: $('#btnRegistro'),
    btnPersonalizar: $('#btnPersonalizar'),

    queueList: $('#queueList'),
    queueEmpty: $('#queueEmpty'),

    modalOverlay: $('#modalOverlay'),
    modalTitle: $('#modalTitle'),
    modalBody: $('#modalBody'),
    modalClose: $('#modalClose'),

    confirmOverlay: $('#confirmOverlay'),
    confirmText: $('#confirmText'),
    confirmCancel: $('#confirmCancel'),
    confirmOk: $('#confirmOk'),

    toast: $('#toast')
  };

  // -----------------------------
  // Settings (defaults)
  // -----------------------------
  const DEFAULTS = {
    baseMinutes: {
      'Corte': 30,
      'Corte + Barba': 45,
      'Corte + Barba + Sellado': 60,
      'Color': 170,
      'Permanente': 160
    },
    selladoDeltaMinutes: {
      'Rápido': 15,
      'Normal': 20,
      'Lento': 25
    },
    speedAdjustMinutes: {
      'Rápido': -10,
      'Normal': 0,
      'Lento': 10,
      'LentoLargo': 15
    }
  };

  const STORAGE = {
    settings: 'barber.settings.v1',
    registro: 'barber.registro.v1'
  };

  let settings = loadJSON(STORAGE.settings, DEFAULTS);

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    running: false,
    startTs: 0,
    endTs: 0,
    durationMs: 0,
    service: '',
    speed: 'Normal',
    overtimeNotified: false,

    queue: [],
    nextReadyId: null,

    registro: loadJSON(STORAGE.registro, [])
  };

  // -----------------------------
  // Utilities
  // -----------------------------
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function now() { return Date.now(); }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtHHMM(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fmtMMSS(ms) {
    const s = Math.floor(Math.abs(ms) / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${pad2(mm)}:${pad2(ss)}`;
  }

  function fmtDurationNice(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
  }

  function minutesToMs(m) { return Math.round(m * 60000); }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch { return fallback; }
  }

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function uid() {
    return Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    el.toast.classList.remove('toast--show');
    // reflow
    void el.toast.offsetWidth;
    el.toast.classList.add('toast--show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.toast.classList.remove('toast--show');
      setTimeout(() => { el.toast.hidden = true; }, 220);
    }, 1600);
  }

  // -----------------------------
  // Feedback (WebAudio + vibrate)
  // -----------------------------
  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx) return audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      return audioCtx;
    } catch {
      return null;
    }
  }

  function clickTick(intensity = 0.035) {
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      // iOS requires a gesture to resume; we attempt but ignore failure.
      ctx.resume().catch(() => {});
    }
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(intensity, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + 0.07);
  }

  function vibrate(ms = 10) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch {}
  }

  function feedback(kind = 'tap') {
    // Ultra subtle
    if (kind === 'danger') clickTick(0.045);
    else clickTick(0.03);
    vibrate(8);
  }

  // -----------------------------
  // Durations
  // -----------------------------
  function calcDurationMs(service, speed) {
    // Base
    let baseMin;
    if (service === 'Corte + Sellado') {
      // base corte + delta sellado
      baseMin = (settings.baseMinutes['Corte'] ?? DEFAULTS.baseMinutes['Corte']) +
        (settings.selladoDeltaMinutes[speed] ?? DEFAULTS.selladoDeltaMinutes[speed]);
    } else {
      baseMin = settings.baseMinutes[service] ?? DEFAULTS.baseMinutes[service] ?? 0;
    }

    // Speed adjust (applies to total)
    let adj = 0;
    if (speed === 'Rápido') adj = settings.speedAdjustMinutes['Rápido'] ?? DEFAULTS.speedAdjustMinutes['Rápido'];
    if (speed === 'Normal') adj = settings.speedAdjustMinutes['Normal'] ?? DEFAULTS.speedAdjustMinutes['Normal'];
    if (speed === 'Lento') {
      const isLong = baseMin > 60;
      const key = isLong ? 'LentoLargo' : 'Lento';
      adj = settings.speedAdjustMinutes[key] ?? DEFAULTS.speedAdjustMinutes[key];
    }

    const totalMin = baseMin + adj;
    return minutesToMs(totalMin);
  }

  function durationLabel(service, speed) {
    const ms = calcDurationMs(service, speed);
    return `${Math.round(ms / 60000)}m`;
  }

  // -----------------------------
  // Schedule classification
  // -----------------------------
  function getActiveLimitTs(refTs) {
    const d = new Date(refTs);
    const h = d.getHours();
    const m = d.getMinutes();
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

    const limit13 = dayStart + (13 * 60 + 0) * 60000;
    const limit22 = dayStart + (22 * 60 + 0) * 60000;

    const isBefore13 = (h < 13) || (h === 12 && m <= 59);
    return isBefore13 ? limit13 : limit22;
  }

  function classifyFinish(finTs, refTs) {
    const limitTs = getActiveLimitTs(refTs);
    const yellowStart = limitTs - 10 * 60000;

    if (finTs <= yellowStart) return { cls: 'ok', label: 'OK', limitTs };
    if (finTs <= limitTs) return { cls: 'warn', label: 'AMARILLO', limitTs };
    return { cls: 'bad', label: 'ROJO', limitTs };
  }

  function getPlannedFinishTs() {
    const t = now();
    if (state.running) {
      if (state.queue.length === 0) return state.endTs;
      return state.queue[state.queue.length - 1].endTs;
    }
    if (state.queue.length) return state.queue[state.queue.length - 1].endTs;
    return t;
  }

  // -----------------------------
  // Queue planning
  // -----------------------------
  function recalcQueue() {
    const t = now();
    let cursor;
    if (state.running) cursor = state.endTs;
    else cursor = t;

    for (const item of state.queue) {
      item.startTs = cursor;
      item.endTs = cursor + item.durationMs;
      cursor = item.endTs;
    }

    if (state.queue.length) {
      state.queue[0].isNext = true;
      for (let i = 1; i < state.queue.length; i++) state.queue[i].isNext = false;
    }

    // If nextReady exists, keep it only if still present
    if (state.nextReadyId && !state.queue.some(q => q.id === state.nextReadyId)) {
      state.nextReadyId = null;
    }
  }

  function computeProjectedFinishWithNew(service, speed) {
    const t = now();
    const durationMs = calcDurationMs(service, speed);

    // Copy cursor logic per spec
    let cursor;
    if (state.running) cursor = state.endTs;
    else cursor = t;

    // existing queue
    if (state.queue.length) cursor = state.queue[state.queue.length - 1].endTs;

    const projectedEnd = cursor + durationMs;
    return projectedEnd;
  }

  // -----------------------------
  // Timer control
  // -----------------------------
  let tickTimer = null;

  function startService(service, speed, fromQueueItem = null) {
    const t = now();
    const durationMs = fromQueueItem ? fromQueueItem.durationMs : calcDurationMs(service, speed);

    state.running = true;
    state.overtimeNotified = false;
    state.startTs = t;
    state.durationMs = durationMs;
    state.endTs = t + durationMs;
    state.service = service;
    state.speed = speed;

    // When starting a nextReady item, clear nextReady
    if (fromQueueItem) {
      state.nextReadyId = null;
    }

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, 250);
    tick();
    renderAll();
  }

  function finalizeCurrent() {
    if (!state.running) return;

    const t = now();
    const actualMs = t - state.startTs;

    // a) guardar registro
    state.registro.push({
      id: uid(),
      service: state.service,
      speed: state.speed,
      startTs: state.startTs,
      endTs: t,
      actualMs
    });
    saveJSON(STORAGE.registro, state.registro);

    // b) detener timer
    state.running = false;
    state.startTs = 0;
    state.endTs = 0;
    state.durationMs = 0;
    state.service = '';
    state.speed = 'Normal';
    state.overtimeNotified = false;

    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    // c) recalcular cola
    recalcQueue();

    // d) marcar el primer item como “Siguiente listo” esperando INICIAR
    if (state.queue.length) {
      state.nextReadyId = state.queue[0].id;
    } else {
      state.nextReadyId = null;
    }

    renderAll();
    toast('Registro guardado');
  }

  function startNextReadyIfAny() {
    if (state.running) return;
    if (!state.nextReadyId) return;

    const idx = state.queue.findIndex(q => q.id === state.nextReadyId);
    if (idx === -1) {
      state.nextReadyId = null;
      return;
    }

    const item = state.queue.splice(idx, 1)[0];
    recalcQueue();
    startService(item.service, item.speed, item);
  }

  function tick() {
    if (!state.running) return;
    const t = now();
    const remaining = state.endTs - t;

    const overtime = remaining < 0;
    if (overtime && !state.overtimeNotified) {
      state.overtimeNotified = true;
      feedback('danger');
    }

    // UI values
    if (!overtime) {
      el.timerValue.textContent = fmtMMSS(remaining);
      el.overtimeTag.hidden = true;
      el.metaValue.textContent = `En proceso: ${state.service}`;
    } else {
      el.timerValue.textContent = `+${fmtMMSS(remaining)}`;
      el.overtimeTag.hidden = false;
      el.metaValue.textContent = 'Demora';
    }

    el.etaValue.textContent = overtime ? `Termina ${fmtHHMM(t)} · Fuera de horario` : `Termina ${fmtHHMM(state.endTs)}`;

    updateRingVisual(remaining);
    updateAddButtonStatus();
  }

  // -----------------------------
  // Ring visual (SVG stroke)
  // -----------------------------
  const R = 92;
  const CIRC = 2 * Math.PI * R;
  el.ringProgress.style.strokeDasharray = `${CIRC} ${CIRC}`;
  el.ringProgress.style.strokeDashoffset = `${0}`;

  function updateRingVisual(remainingMs) {
    const t = now();
    const total = state.running ? state.durationMs : minutesToMs(30);

    const overtime = remainingMs < 0;
    const ringCard = $('.timerCard');

    if (overtime) {
      ringCard.classList.add('is-overtime');
      ringCard.classList.remove('is-running');
      el.ringProgress.style.strokeDashoffset = `${0}`;
      // cap becomes subtle pulse at top
      setCapByAngle(-90);
      el.ringCap.style.opacity = '0.55';
      el.ringPulse.style.opacity = '1';
      return;
    }

    ringCard.classList.remove('is-overtime');
    if (state.running) ringCard.classList.add('is-running');
    else ringCard.classList.remove('is-running');

    if (!state.running) {
      // idle: fully lit
      el.ringProgress.style.strokeDashoffset = `${0}`;
      setCapByAngle(-90);
      el.ringCap.style.opacity = '1';
      el.ringPulse.style.opacity = '0.65';
      return;
    }

    const elapsed = clamp(t - state.startTs, 0, total);
    const ratio = 1 - (elapsed / total);

    // Depletion: reduce the visible stroke
    const offset = (1 - ratio) * CIRC;
    el.ringProgress.style.strokeDashoffset = `${offset}`;

    // cap follows the end of the stroke
    const angle = -90 + ratio * 360;
    setCapByAngle(angle);
    el.ringCap.style.opacity = '1';
    el.ringPulse.style.opacity = '0.8';
  }

  function setCapByAngle(deg) {
    const rad = (deg * Math.PI) / 180;
    const cx = 110;
    const cy = 110;
    const x = cx + R * Math.cos(rad);
    const y = cy + R * Math.sin(rad);
    el.ringCap.setAttribute('cx', x.toFixed(2));
    el.ringCap.setAttribute('cy', y.toFixed(2));
  }

  // -----------------------------
  // Render
  // -----------------------------
  function renderAll() {
    renderHeaderTimer();
    recalcQueue();
    renderQueue();
    updateAddButtonStatus();
  }

  function renderHeaderTimer() {
    if (!state.running) {
      el.actionLabel.textContent = 'INICIAR';
      el.timerValue.textContent = '--:--';
      el.etaValue.textContent = 'Termina --:--';
      el.metaValue.textContent = 'Libre';
      el.overtimeTag.hidden = true;

      updateRingVisual(0);
      return;
    }

    el.actionLabel.textContent = 'FINALIZAR';
    el.etaValue.textContent = `Termina ${fmtHHMM(state.endTs)}`;
    tick();
  }

  function renderQueue() {
    el.queueList.innerHTML = '';
    if (!state.queue.length) {
      el.queueEmpty.hidden = false;
      return;
    }
    el.queueEmpty.hidden = true;

    for (let i = 0; i < state.queue.length; i++) {
      const item = state.queue[i];
      const card = document.createElement('div');
      card.className = 'qCard';
      card.dataset.id = item.id;

      // Next highlight
      if (i === 0) {
        card.classList.add('is-next');
        if (state.nextReadyId === item.id) card.classList.add('is-ready');
      }

      const waitMin = Math.max(0, Math.round((item.startTs - now()) / 60000));

      card.innerHTML = `
        <div class="qSwipe">
          <button class="qDelete" type="button">Eliminar</button>
          <div class="qFront">
            <div class="qLeft">
              <div class="qIcon">${serviceIconSVG(item.service)}</div>
            </div>
            <div class="qMid">
              <div class="qTopLine">
                <div class="qTitle">${escapeHTML(item.service)}</div>
                ${i === 0 ? `<span class="qBadge">PRÓXIMO</span>` : ''}
              </div>
              <div class="qSub">
                <span>${escapeHTML(item.speed)}</span>
                <span class="dot">•</span>
                <span>${Math.round(item.durationMs / 60000)}m</span>
                <span class="dot">•</span>
                <span>Espera: ${waitMin}m</span>
              </div>
              <div class="qTimes">Inicio ${fmtHHMM(item.startTs)} / Fin ${fmtHHMM(item.endTs)}</div>
            </div>
          </div>
        </div>
      `;

      el.queueList.appendChild(card);
    }

    bindQueueInteractions();
  }

  function escapeHTML(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  // -----------------------------
  // Icons per service (SVG, no emoji)
  // -----------------------------
  function serviceIconSVG(service) {
    const stroke = 'rgba(234,242,248,.92)';
    const glow = 'rgba(79,209,255,.55)';

    // Minimal line icons
    if (service === 'Corte') {
      return `
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M7 6l10 10" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M10 3l3 3" fill="none" stroke="${glow}" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M14 12l7-7" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M5 14l-2 2 3 3 2-2" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    }
    if (service === 'Corte + Barba' || service === 'Corte + Barba + Sellado') {
      return `
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M12 4a6 6 0 0 0-6 6v2a6 6 0 0 0 12 0v-2a6 6 0 0 0-6-6Z" fill="none" stroke="${stroke}" stroke-width="1.7"/>
          <path d="M8 13c1.2 1 2.6 1.5 4 1.5S14.8 14 16 13" fill="none" stroke="${glow}" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M9 16c.8 2 2 3 3 3s2.2-1 3-3" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>
        </svg>`;
    }
    if (service === 'Corte + Sellado') {
      return `
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M7 7h10" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M9 5v14" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M15 5v14" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M12 10c-1.2 1.1-1.2 2.9 0 4 1.2-1.1 1.2-2.9 0-4Z" fill="none" stroke="${glow}" stroke-width="1.6" stroke-linejoin="round"/>
        </svg>`;
    }
    if (service === 'Color') {
      return `
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M7 3h10v6a5 5 0 0 1-10 0V3Z" fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linejoin="round"/>
          <path d="M9 21h6" fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round"/>
          <path d="M12 9v4" fill="none" stroke="${glow}" stroke-width="1.6" stroke-linecap="round"/>
        </svg>`;
    }
    if (service === 'Permanente') {
      return `
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M6 18c0-2 2-3 3-4s1-3 0-4 0-3 2-4 5 0 5 2-2 3-3 4-1 3 0 4 0 3-2 4-5 0-5-2Z" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="M8 12h8" fill="none" stroke="${glow}" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`;
    }

    // Fallback
    return `
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M6 12h12" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M12 6v12" fill="none" stroke="${glow}" stroke-width="1.6" stroke-linecap="round"/>
      </svg>`;
  }

  // -----------------------------
  // Add button status + confirm on red
  // -----------------------------
  function updateAddButtonStatus() {
    const finTs = getPlannedFinishTs();
    const t = now();
    const { cls, limitTs } = classifyFinish(finTs, t);

    el.btnAdd.classList.remove('is-ok', 'is-warn', 'is-bad');
    el.btnAdd.classList.add(`is-${cls}`);

    // store for confirm text
    el.btnAdd.dataset.limitTs = String(limitTs);
    el.btnAdd.dataset.cls = cls;
  }

  // -----------------------------
  // Modal system
  // -----------------------------
  let activeModal = null;

  function openModal(title, bodyNodeOrHTML, opts = {}) {
    activeModal = opts.name || 'modal';
    el.modalTitle.textContent = title;

    el.modalBody.innerHTML = '';
    if (typeof bodyNodeOrHTML === 'string') {
      el.modalBody.innerHTML = bodyNodeOrHTML;
    } else {
      el.modalBody.appendChild(bodyNodeOrHTML);
    }

    el.modalOverlay.hidden = false;
    requestAnimationFrame(() => {
      el.modalOverlay.classList.add('is-open');
    });

    // lock background scroll
    document.documentElement.classList.add('modalOpen');
    document.body.classList.add('modalOpen');

    // focus
    el.modalClose.focus({ preventScroll: true });

    feedback('tap');
  }

  function closeModal() {
    if (el.modalOverlay.hidden) return;
    el.modalOverlay.classList.remove('is-open');
    setTimeout(() => {
      el.modalOverlay.hidden = true;
      el.modalBody.innerHTML = '';
      activeModal = null;
    }, 220);

    document.documentElement.classList.remove('modalOpen');
    document.body.classList.remove('modalOpen');

    feedback('tap');
  }

  el.modalClose.addEventListener('click', closeModal);
  el.modalOverlay.addEventListener('click', (e) => {
    if (e.target === el.modalOverlay) closeModal();
  });

  // -----------------------------
  // Confirm overlay
  // -----------------------------
  function confirmAddRed(text, onOk) {
    el.confirmText.textContent = text;
    el.confirmOverlay.hidden = false;
    requestAnimationFrame(() => el.confirmOverlay.classList.add('is-open'));

    const cleanup = () => {
      el.confirmOverlay.classList.remove('is-open');
      setTimeout(() => { el.confirmOverlay.hidden = true; }, 180);
    };

    const cancel = () => {
      cleanup();
      feedback('tap');
    };

    const ok = () => {
      cleanup();
      feedback('tap');
      onOk();
    };

    el.confirmCancel.onclick = cancel;
    el.confirmOk.onclick = ok;

    feedback('tap');
  }

  // -----------------------------
  // Add client (2 steps)
  // -----------------------------
  const SPEEDS = ['Rápido', 'Normal', 'Lento'];
  const SERVICES = [
    'Corte',
    'Corte + Barba',
    'Corte + Sellado',
    'Corte + Barba + Sellado',
    'Color',
    'Permanente'
  ];

  function openAddClientModal() {
    const wrap = document.createElement('div');
    wrap.className = 'bubbleFlow';

    const stepPill = document.createElement('div');
    stepPill.className = 'stepPill';
    stepPill.innerHTML = `
      <div class="stepDot is-on"></div>
      <div class="stepDot"></div>
    `;

    const title = document.createElement('div');
    title.className = 'stepTitle';
    title.textContent = 'Elegí velocidad';

    const speedRow = document.createElement('div');
    speedRow.className = 'bubbleRow';

    let chosenSpeed = null;

    for (const sp of SPEEDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bubbleBtn';
      b.textContent = sp;
      b.addEventListener('click', () => {
        chosenSpeed = sp;
        feedback('tap');

        // Step 2
        title.textContent = 'Elegí servicio';
        stepPill.innerHTML = `
          <div class="stepDot"></div>
          <div class="stepDot is-on"></div>
        `;

        const serviceGrid = document.createElement('div');
        serviceGrid.className = 'serviceGrid';

        for (const sv of SERVICES) {
          const sbtn = document.createElement('button');
          sbtn.type = 'button';
          sbtn.className = 'serviceCard';
          const d = durationLabel(sv, chosenSpeed);
          sbtn.innerHTML = `
            <div class="serviceIcon">${serviceIconSVG(sv)}</div>
            <div class="serviceName">${escapeHTML(sv)}</div>
            <div class="serviceMeta">${escapeHTML(chosenSpeed)} · ${d}</div>
          `;
          sbtn.addEventListener('click', () => {
            feedback('tap');
            closeModal();
            handleAddSelected(chosenSpeed, sv);
          });
          serviceGrid.appendChild(sbtn);
        }

        // Replace content
        speedRow.replaceWith(serviceGrid);
      });
      speedRow.appendChild(b);
    }

    wrap.appendChild(stepPill);
    wrap.appendChild(title);
    wrap.appendChild(speedRow);

    const hint = document.createElement('div');
    hint.className = 'modalHint';
    hint.textContent = 'Cancelar con la X';
    wrap.appendChild(hint);

    openModal('Agregar cliente', wrap, { name: 'add' });
  }

  function handleAddSelected(speed, service) {
    // If adding would turn red => confirm
    const projectedFinish = computeProjectedFinishWithNew(service, speed);
    const t = now();
    const { cls, limitTs } = classifyFinish(projectedFinish, t);

    const doAdd = () => {
      // Add logic per spec
      if (state.running) {
        enqueue(service, speed);
      } else {
        // If no running: start immediately
        startService(service, speed);
      }
      renderAll();
    };

    if (cls === 'bad') {
      const text = `Terminarías ${fmtHHMM(projectedFinish)} (límite ${fmtHHMM(limitTs)}). ¿Agregar igual?`;
      confirmAddRed(text, doAdd);
      return;
    }

    doAdd();
  }

  function enqueue(service, speed) {
    const item = {
      id: uid(),
      service,
      speed,
      durationMs: calcDurationMs(service, speed),
      startTs: 0,
      endTs: 0,
      isNext: false
    };

    state.queue.push(item);
    recalcQueue();
  }

  // -----------------------------
  // Personalizar modal
  // -----------------------------
  function openPersonalizarModal() {
    const wrap = document.createElement('div');
    wrap.className = 'formWrap';

    const section1 = formSection('Tiempos base (min)', [
      ['Corte', 'baseMinutes.Corte'],
      ['Corte + Barba', 'baseMinutes.Corte + Barba'],
      ['Corte + Barba + Sellado', 'baseMinutes.Corte + Barba + Sellado'],
      ['Color', 'baseMinutes.Color'],
      ['Permanente', 'baseMinutes.Permanente']
    ]);

    const section2 = formSection('Delta Sellado (min) — solo Corte + Sellado', [
      ['Rápido', 'selladoDeltaMinutes.Rápido'],
      ['Normal', 'selladoDeltaMinutes.Normal'],
      ['Lento', 'selladoDeltaMinutes.Lento']
    ]);

    const section3 = formSection('Ajuste por velocidad (min)', [
      ['Rápido (-10)', 'speedAdjustMinutes.Rápido'],
      ['Normal (0)', 'speedAdjustMinutes.Normal'],
      ['Lento (<=60)', 'speedAdjustMinutes.Lento'],
      ['Lento (>60)', 'speedAdjustMinutes.LentoLargo']
    ]);

    wrap.appendChild(section1);
    wrap.appendChild(section2);
    wrap.appendChild(section3);

    const actions = document.createElement('div');
    actions.className = 'formActions';
    actions.innerHTML = `
      <button class="chipBtn chipBtn--ghost" type="button" id="btnRestore">Restaurar defaults</button>
      <button class="chipBtn" type="button" id="btnSave">Guardar</button>
    `;
    wrap.appendChild(actions);

    openModal('Personalizar', wrap, { name: 'custom' });

    $('#btnRestore', wrap).addEventListener('click', () => {
      settings = structuredClone(DEFAULTS);
      saveJSON(STORAGE.settings, settings);
      feedback('tap');
      toast('Defaults restaurados');
      closeModal();
      renderAll();
    });

    $('#btnSave', wrap).addEventListener('click', () => {
      const inputs = $$('input[data-path]', wrap);
      for (const inp of inputs) {
        const path = inp.dataset.path;
        const val = Number(inp.value);
        if (!Number.isFinite(val)) continue;
        setByPath(settings, path, val);
      }
      saveJSON(STORAGE.settings, settings);
      feedback('tap');
      toast('Guardado');
      closeModal();
      renderAll();
    });
  }

  function formSection(title, rows) {
    const sec = document.createElement('div');
    sec.className = 'formSection';

    const h = document.createElement('div');
    h.className = 'formTitle';
    h.textContent = title;

    const list = document.createElement('div');
    list.className = 'formList';

    for (const [label, pathLabel] of rows) {
      const path = toPath(pathLabel);
      const val = getByPath(settings, path);

      const row = document.createElement('div');
      row.className = 'formRow';
      row.innerHTML = `
        <div class="formLabel">${escapeHTML(label)}</div>
        <input class="formInput" inputmode="numeric" pattern="[0-9]*" data-path="${escapeHTML(path)}" value="${escapeHTML(String(val))}" />
      `;
      list.appendChild(row);
    }

    sec.appendChild(h);
    sec.appendChild(list);
    return sec;
  }

  function toPath(label) {
    // Label already has dots. Ensure we remove spaces around +
    return label
      .replaceAll(' + ', ' + ')
      .replaceAll(' ', '')
      .replaceAll('baseMinutes.', 'baseMinutes.')
      .replaceAll('selladoDeltaMinutes.', 'selladoDeltaMinutes.')
      .replaceAll('speedAdjustMinutes.', 'speedAdjustMinutes.');
  }

  function getByPath(obj, path) {
    // Special keys with plus and accents are handled by bracket notation via map
    // We'll convert known keys.
    if (path.startsWith('baseMinutes.')) {
      const key = path.slice('baseMinutes.'.length).replaceAll('+', ' + ');
      return obj.baseMinutes[key] ?? DEFAULTS.baseMinutes[key] ?? 0;
    }
    if (path.startsWith('selladoDeltaMinutes.')) {
      const key = path.slice('selladoDeltaMinutes.'.length);
      return obj.selladoDeltaMinutes[key] ?? DEFAULTS.selladoDeltaMinutes[key] ?? 0;
    }
    if (path.startsWith('speedAdjustMinutes.')) {
      const key = path.slice('speedAdjustMinutes.'.length);
      return obj.speedAdjustMinutes[key] ?? DEFAULTS.speedAdjustMinutes[key] ?? 0;
    }
    return 0;
  }

  function setByPath(obj, path, value) {
    if (path.startsWith('baseMinutes.')) {
      const key = path.slice('baseMinutes.'.length).replaceAll('+', ' + ');
      obj.baseMinutes[key] = value;
      return;
    }
    if (path.startsWith('selladoDeltaMinutes.')) {
      const key = path.slice('selladoDeltaMinutes.'.length);
      obj.selladoDeltaMinutes[key] = value;
      return;
    }
    if (path.startsWith('speedAdjustMinutes.')) {
      const key = path.slice('speedAdjustMinutes.'.length);
      obj.speedAdjustMinutes[key] = value;
      return;
    }
  }

  // -----------------------------
  // Registro modal
  // -----------------------------
  function openRegistroModal() {
    const wrap = document.createElement('div');
    wrap.className = 'registroWrap';

    const totalMs = state.registro.reduce((a, r) => a + (r.actualMs || 0), 0);

    const top = document.createElement('div');
    top.className = 'registroTop';
    top.innerHTML = `
      <div class="registroStats">
        <div class="registroStat">
          <div class="registroStat__label">Total servicios</div>
          <div class="registroStat__value">${state.registro.length}</div>
        </div>
        <div class="registroStat">
          <div class="registroStat__label">Tiempo total</div>
          <div class="registroStat__value">${escapeHTML(fmtDurationNice(totalMs))}</div>
        </div>
      </div>
    `;

    const list = document.createElement('div');
    list.className = 'registroList';

    if (!state.registro.length) {
      const empty = document.createElement('div');
      empty.className = 'registroEmpty';
      empty.textContent = 'No hay registros todavía';
      list.appendChild(empty);
    } else {
      for (const r of state.registro.slice().reverse()) {
        const row = document.createElement('div');
        row.className = 'registroRow';
        row.innerHTML = `
          <div class="registroRow__main">
            <div class="registroRow__title">${escapeHTML(r.service)}</div>
            <div class="registroRow__sub">${fmtHHMM(r.startTs)}-${fmtHHMM(r.endTs)} · ${escapeHTML(fmtDurationNice(r.actualMs))}</div>
          </div>
        `;
        list.appendChild(row);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'registroActions';
    actions.innerHTML = `
      <button class="chipBtn chipBtn--ghost" type="button" id="btnCopy">Copiar</button>
      <button class="chipBtn chipBtn--ghost" type="button" id="btnClear">Borrar registro</button>
    `;

    wrap.appendChild(top);
    wrap.appendChild(list);
    wrap.appendChild(actions);

    openModal('Registro', wrap, { name: 'registro' });

    $('#btnCopy', wrap).addEventListener('click', async () => {
      const text = buildRegistroText();
      try {
        await navigator.clipboard.writeText(text);
        feedback('tap');
        toast('Copiado');
      } catch {
        feedback('tap');
        toast('No se pudo copiar');
      }
    });

    $('#btnClear', wrap).addEventListener('click', () => {
      state.registro = [];
      saveJSON(STORAGE.registro, state.registro);
      feedback('tap');
      toast('Registro borrado');
      closeModal();
      renderAll();
    });
  }

  function buildRegistroText() {
    const lines = [];
    const totalMs = state.registro.reduce((a, r) => a + (r.actualMs || 0), 0);
    lines.push(`Registro (${state.registro.length} servicios) — Total ${fmtDurationNice(totalMs)}`);
    lines.push('');
    for (const r of state.registro) {
      lines.push(`${r.service} (${r.speed}) — ${fmtHHMM(r.startTs)}-${fmtHHMM(r.endTs)} — ${fmtDurationNice(r.actualMs)}`);
    }
    return lines.join('\n');
  }

  // -----------------------------
  // Swipe to delete (iOS-like)
  // -----------------------------
  const swipe = {
    openId: null,
    startX: 0,
    currentX: 0,
    dragging: false,
    activeCard: null
  };

  function bindQueueInteractions() {
    // Remove previous handlers by cloning? We bind per card.
    $$('.qCard', el.queueList).forEach(card => {
      const front = $('.qFront', card);
      const del = $('.qDelete', card);

      // Delete
      del.addEventListener('click', () => {
        feedback('danger');
        removeQueueItem(card.dataset.id);
      });

      // Pointer events for swipe
      let pointerId = null;

      front.addEventListener('pointerdown', (e) => {
        pointerId = e.pointerId;
        front.setPointerCapture(pointerId);
        swipe.dragging = true;
        swipe.activeCard = card;
        swipe.startX = e.clientX;
        swipe.currentX = 0;

        // close any other open
        closeOpenSwipeExcept(card.dataset.id);
      });

      front.addEventListener('pointermove', (e) => {
        if (!swipe.dragging || swipe.activeCard !== card) return;
        const dx = e.clientX - swipe.startX;
        const tx = clamp(dx, -96, 16);
        swipe.currentX = tx;
        setSwipeTranslate(card, tx);
      });

      front.addEventListener('pointerup', (e) => {
        if (!swipe.dragging || swipe.activeCard !== card) return;
        swipe.dragging = false;
        const shouldOpen = swipe.currentX < -42;
        if (shouldOpen) {
          openSwipe(card);
        } else {
          closeSwipe(card);
        }
      });

      front.addEventListener('pointercancel', () => {
        if (swipe.activeCard === card) {
          swipe.dragging = false;
          closeSwipe(card);
        }
      });
    });
  }

  function setSwipeTranslate(card, x) {
    const front = $('.qFront', card);
    front.style.transform = `translate3d(${x}px,0,0)`;
  }

  function openSwipe(card) {
    setSwipeTranslate(card, -86);
    card.classList.add('swipe-open');
    swipe.openId = card.dataset.id;
    feedback('tap');
  }

  function closeSwipe(card) {
    setSwipeTranslate(card, 0);
    card.classList.remove('swipe-open');
    if (swipe.openId === card.dataset.id) swipe.openId = null;
  }

  function closeOpenSwipeExcept(keepId) {
    if (!swipe.openId) return;
    if (swipe.openId === keepId) return;
    const other = $(`.qCard[data-id="${CSS.escape(swipe.openId)}"]`);
    if (other) closeSwipe(other);
  }

  function removeQueueItem(id) {
    const card = $(`.qCard[data-id="${CSS.escape(id)}"]`);
    if (!card) return;

    card.classList.add('removing');

    // remove after animation
    setTimeout(() => {
      const idx = state.queue.findIndex(q => q.id === id);
      if (idx !== -1) state.queue.splice(idx, 1);

      // if it was nextReady, clear
      if (state.nextReadyId === id) state.nextReadyId = null;

      recalcQueue();
      renderQueue();
      updateAddButtonStatus();
    }, 220);
  }

  // Close swipe if tap outside
  document.addEventListener('pointerdown', (e) => {
    if (!swipe.openId) return;
    const card = $(`.qCard[data-id="${CSS.escape(swipe.openId)}"]`);
    if (!card) {
      swipe.openId = null;
      return;
    }
    if (!card.contains(e.target)) {
      closeSwipe(card);
    }
  }, { capture: true });

  // -----------------------------
  // Events
  // -----------------------------
  el.btnAdd.addEventListener('click', () => {
    feedback('tap');
    openAddClientModal();
  });

  el.btnRegistro.addEventListener('click', () => {
    feedback('tap');
    openRegistroModal();
  });

  el.btnPersonalizar.addEventListener('click', () => {
    feedback('tap');
    openPersonalizarModal();
  });

  el.btnCentral.addEventListener('click', () => {
    if (state.running) {
      feedback('tap');
      finalizeCurrent();
      return;
    }

    // free
    feedback('tap');
    if (state.nextReadyId) {
      startNextReadyIfAny();
    } else {
      // If nothing ready, open add flow to start a service.
      openAddClientModal();
    }
  });

  // Keyboard access
  el.btnCentral.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.btnCentral.click();
    }
  });

  // -----------------------------
  // iPhone notch + prevent zoom / gesture nav weirdness
  // -----------------------------
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(evt => {
    document.addEventListener(evt, (e) => e.preventDefault(), { passive: false });
  });

  // Prevent double-tap zoom
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const nowTs = Date.now();
    if (nowTs - lastTouchEnd <= 300) {
      e.preventDefault();
    }
    lastTouchEnd = nowTs;
  }, { passive: false });

  // Keep body from horizontal pan
  document.addEventListener('touchmove', (e) => {
    // Allow scroll only inside modal body (Personalizar/Registro)
    const inScrollableModal = e.target && e.target.closest && e.target.closest('.modalBody') &&
      (activeModal === 'custom' || activeModal === 'registro');
    if (inScrollableModal) return;
    // Otherwise prevent accidental page scroll
    if (el.modalOverlay.hidden) e.preventDefault();
  }, { passive: false });

  // -----------------------------
  // Service Worker
  // -----------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // -----------------------------
  // Init
  // -----------------------------
  function init() {
    renderAll();
    updateAddButtonStatus();

    // If there was running state previously, we intentionally do not restore it
    // (requirements did not ask persistence for running timer).
  }

  init();

})();
