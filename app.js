/* Barber Turnos - PWA - Vanilla JS
   Regla de oro: el rediseño es UI only. Este proyecto implementa exactamente los flujos
   funcionales solicitados sin frameworks ni librerías externas.
*/

'use strict';

// ---------- Utils ----------
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const pad2 = (n) => String(n).padStart(2,'0');

function formatClock(ts){
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatMMSS(ms){
  const total = Math.max(0, Math.round(ms/1000));
  const m = Math.floor(total/60);
  const s = total % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

function formatPlusMMSS(ms){
  const total = Math.max(0, Math.round(ms/1000));
  const m = Math.floor(total/60);
  const s = total % 60;
  return `+${pad2(m)}:${pad2(s)}`;
}

function formatDurationHM(mins){
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m/60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function clamp(v, a, b){return Math.max(a, Math.min(b, v));}

// ---------- Storage ----------
const LS_KEY_SETTINGS = 'barber_turnos_settings_v1';
const LS_KEY_REGISTRO = 'barber_turnos_registro_v1';

const DEFAULT_SETTINGS = {
  base: {
    'Corte': 30,
    'Corte + Barba': 45,
    'Corte + Barba + Sellado': 60,
    'Color': 170,
    'Permanente': 160,
  },
  deltaSellado: {
    'Rápido': 15,
    'Normal': 20,
    'Lento': 25,
  },
  ajusteVelocidad: {
    'Rápido': -10,
    'Normal': 0,
    'LentoCorto': 10, // <=60
    'LentoLargo': 15, // >60
  }
};

function loadSettings(){
  try {
    const raw = localStorage.getItem(LS_KEY_SETTINGS);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    return {
      base: {...DEFAULT_SETTINGS.base, ...(parsed.base || {})},
      deltaSellado: {...DEFAULT_SETTINGS.deltaSellado, ...(parsed.deltaSellado || {})},
      ajusteVelocidad: {...DEFAULT_SETTINGS.ajusteVelocidad, ...(parsed.ajusteVelocidad || {})},
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings(s){
  localStorage.setItem(LS_KEY_SETTINGS, JSON.stringify(s));
}

function loadRegistro(){
  try {
    const raw = localStorage.getItem(LS_KEY_REGISTRO);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRegistro(list){
  localStorage.setItem(LS_KEY_REGISTRO, JSON.stringify(list));
}

// ---------- Haptics & Sound ----------
let audioCtx = null;
function clickFx(){
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(640, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.02, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(now);
    osc.stop(now + 0.035);
  } catch {
    // silent fallback
  }
}

function vibrate(pattern){
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    // silent
  }
}

function feedback(kind){
  // Ultra sutil: click + vibra suave
  clickFx();
  if (kind === 'danger') vibrate([18]);
  else vibrate([10]);
}

// ---------- App State ----------
const state = {
  settings: loadSettings(),
  registro: loadRegistro(),
  current: null, // { service, speed, plannedMin, startTs, plannedMs, overtimeNotified }
  queue: [], // items: {id, service, speed, plannedMin, startTs, endTs, ready}
  timerId: null,
  addModalStep: 1,
  addModalSpeed: null,
  deadlineClass: 'ok',
};

// ---------- Duration rules ----------
function calcPlannedMinutes(service, speed){
  const s = state.settings;

  let total = 0;

  if (service === 'Corte + Sellado'){
    // base corte (normal) + delta sellado por velocidad
    total = Number(s.base['Corte'] ?? 30) + Number(s.deltaSellado[speed] ?? 20);
  } else if (service === 'Corte + Sellado (sin barba)') {
    // alias defensivo
    total = Number(s.base['Corte'] ?? 30) + Number(s.deltaSellado[speed] ?? 20);
  } else {
    total = Number(s.base[service] ?? 0);
  }

  // Ajuste por velocidad aplicado al total resultante
  if (speed === 'Rápido') total += Number(s.ajusteVelocidad['Rápido'] ?? -10);
  if (speed === 'Normal') total += Number(s.ajusteVelocidad['Normal'] ?? 0);
  if (speed === 'Lento'){
    const adjKey = total <= 60 ? 'LentoCorto' : 'LentoLargo';
    total += Number(s.ajusteVelocidad[adjKey] ?? (total <= 60 ? 10 : 15));
  }

  return Math.max(1, Math.round(total));
}

function serviceList(){
  return [
    { key: 'Corte', baseLabel: 'Corte (base 30)' },
    { key: 'Corte + Barba', baseLabel: 'Corte + Barba (base 45)' },
    { key: 'Corte + Sellado', baseLabel: 'Corte + Sellado (base Corte + delta sellado)' },
    { key: 'Corte + Barba + Sellado', baseLabel: 'Corte + Barba + Sellado (base 60)' },
    { key: 'Color', baseLabel: 'Color (base 170)' },
    { key: 'Permanente', baseLabel: 'Permanente (base 160)' },
  ];
}

// ---------- Deadlines ----------
function getActiveLimitTs(nowTs){
  const now = new Date(nowTs);
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const thirteen = new Date(y, mo, d, 13, 0, 0, 0).getTime();
  const twentyTwo = new Date(y, mo, d, 22, 0, 0, 0).getTime();
  return nowTs < thirteen ? thirteen : twentyTwo;
}

function classifyDeadline(plannedEndTs, nowTs){
  const limit = getActiveLimitTs(nowTs);
  const yellow = limit - 10*60*1000;
  if (plannedEndTs <= yellow) return {cls:'ok', limitTs: limit};
  if (plannedEndTs <= limit) return {cls:'warn', limitTs: limit};
  return {cls:'danger', limitTs: limit};
}

function getLastPlannedEndTs(nowTs){
  // último: cola o actual
  if (state.queue.length){
    const last = state.queue[state.queue.length - 1];
    return last.endTs;
  }
  if (state.current){
    return state.current.startTs + state.current.plannedMs;
  }
  return nowTs;
}

// ---------- Queue scheduling ----------
function recalcQueue(){
  const nowTs = Date.now();
  let cursor = nowTs;
  if (state.current){
    cursor = state.current.startTs + state.current.plannedMs;
  }

  for (const item of state.queue){
    item.startTs = cursor;
    item.endTs = cursor + item.plannedMin*60*1000;
    cursor = item.endTs;
  }

  // Badge "PRÓXIMO" siempre para el primero
  state.queue.forEach((it, idx)=>{
    it.isNext = idx === 0;
  });

  // Clasificación visual del botón Agregar cliente
  const lastEnd = getLastPlannedEndTs(nowTs);
  const {cls} = classifyDeadline(lastEnd, nowTs);
  state.deadlineClass = cls;

  renderQueue();
  renderAddButtonClass();
}

// ---------- UI refs ----------
const els = {
  btnCentral: $('#btnCentral'),
  ring: $('#ring'),
  cap: $('#ringCap'),
  ringGlow: $('#ringGlow'),
  timerAction: $('#timerAction'),
  timerTime: $('#timerTime'),
  timerEnd: $('#timerEnd'),
  timerMeta: $('#timerMeta'),
  timerOvertime: $('#timerOvertime'),
  btnAgregar: $('#btnAgregar'),
  listaEspera: $('#listaEspera'),
  emptyState: $('#emptyState'),
  app: $('#app'),

  modalAgregar: $('#modalAgregar'),
  addCerrar: $('#addCerrar'),
  bubblesVel: $('#bubblesVelocidad'),
  bubblesSrv: $('#bubblesServicio'),

  modalPersonalizar: $('#modalPersonalizar'),
  personalizarCerrar: $('#personalizarCerrar'),
  modalRegistro: $('#modalRegistro'),
  registroCerrar: $('#registroCerrar'),

  btnRegistro: $('#btnRegistro'),
  btnPersonalizar: $('#btnPersonalizar'),

  // Personalizar inputs
  inpCorte: $('#tiempoCorte'),
  inpCorteBarba: $('#tiempoCorteBarba'),
  inpCorteBarbaSellado: $('#tiempoCorteBarbaSellado'),
  inpColor: $('#tiempoColor'),
  inpPermanente: $('#tiempoPermanente'),
  inpDeltaRapido: $('#deltaSelladoRapido'),
  inpDeltaNormal: $('#deltaSelladoNormal'),
  inpDeltaLento: $('#deltaSelladoLento'),
  inpAdjRapido: $('#ajusteRapido'),
  inpAdjNormal: $('#ajusteNormal'),
  inpAdjLentoCorto: $('#ajusteLentoCorto'),
  inpAdjLentoLargo: $('#ajusteLentoLargo'),
  btnRestoreDefaults: $('#btnRestoreDefaults'),
  btnGuardarPersonalizar: $('#btnGuardarPersonalizar'),

  // Registro
  registroResumen: $('#registroResumen'),
  registroLista: $('#registroLista'),
  btnCopiarRegistro: $('#btnCopiarRegistro'),
  btnBorrarRegistro: $('#btnBorrarRegistro'),
};

// ---------- Render: timer ring ----------
const RING_RADIUS = 46;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;
els.ring.style.strokeDasharray = String(RING_CIRC);
els.ring.style.strokeDashoffset = '0';
els.ringGlow.style.strokeDasharray = String(RING_CIRC);
els.ringGlow.style.strokeDashoffset = '0';

function setRingProgressRemaining(fracRemaining){
  const f = clamp(fracRemaining, 0, 1);
  const off = (1 - f) * RING_CIRC;
  els.ring.style.strokeDashoffset = String(off);
  els.ringGlow.style.strokeDashoffset = String(off);

  // cap position
  const angle = (-90 + 360*f) * (Math.PI/180);
  const cx = 60 + Math.cos(angle) * RING_RADIUS;
  const cy = 60 + Math.sin(angle) * RING_RADIUS;
  els.cap.setAttribute('cx', cx.toFixed(2));
  els.cap.setAttribute('cy', cy.toFixed(2));
  // esconder cap cuando está apagado al 100%
  els.cap.style.opacity = f <= 0.001 ? '0' : '1';
}

function setRingOvertime(isOver){
  document.documentElement.classList.toggle('isOvertime', isOver);
}

// ---------- Timer loop ----------
function startTimerLoop(){
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = setInterval(tick, 250);
  tick();
}

function stopTimerLoop(){
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
}

function tick(){
  const nowTs = Date.now();

  // update top-level deadline class periodically
  if (!state.current) recalcQueue();

  if (!state.current){
    setRingOvertime(false);
    setRingProgressRemaining(1);
    els.timerAction.textContent = 'INICIAR';
    els.timerTime.textContent = '--:--';
    els.timerEnd.textContent = 'Termina --:--';
    els.timerMeta.textContent = 'Libre';
    els.timerOvertime.hidden = true;
    els.btnCentral.setAttribute('data-state', 'idle');
    return;
  }

  const elapsed = nowTs - state.current.startTs;
  const remaining = state.current.plannedMs - elapsed;
  const isOver = remaining < 0;

  if (isOver && !state.current.overtimeNotified){
    state.current.overtimeNotified = true;
    feedback('danger');
  }

  setRingOvertime(isOver);

  if (!isOver){
    setRingProgressRemaining(remaining / state.current.plannedMs);
    els.timerTime.textContent = formatMMSS(remaining);
    els.timerOvertime.hidden = true;
  } else {
    setRingProgressRemaining(0);
    els.timerTime.textContent = formatPlusMMSS(-remaining);
    els.timerOvertime.hidden = false;
  }

  els.timerAction.textContent = 'FINALIZAR';
  els.timerEnd.textContent = `Termina ${formatClock(state.current.startTs + state.current.plannedMs)}`;
  els.timerMeta.textContent = isOver ? 'Demora' : `En proceso: ${state.current.service}`;
  els.btnCentral.setAttribute('data-state', 'running');

  // Update add-button class
  const lastEnd = getLastPlannedEndTs(nowTs);
  const {cls} = classifyDeadline(lastEnd, nowTs);
  state.deadlineClass = cls;
  renderAddButtonClass();
}

// ---------- Render: queue ----------
function iconForService(service){
  // Minimal SVG per service, no emoji.
  // returns inner SVG paths (viewBox 0 0 24 24)
  const m = {
    'Corte': 'M7 4h10v2H7V4zm-2 3h14v2H5V7zm3 4h8v2H8v-2zm-1 4h10v2H7v-2z',
    'Corte + Barba': 'M12 3a5 5 0 0 1 5 5v2a4 4 0 0 1-2 3.46V16a3 3 0 0 1-6 0v-2.54A4 4 0 0 1 7 10V8a5 5 0 0 1 5-5zm-3 7a3 3 0 0 0 6 0V8a3 3 0 0 0-6 0v2z',
    'Corte + Sellado': 'M12 2l5 9h-4v11H11V11H7l5-9z',
    'Corte + Barba + Sellado': 'M12 2l5 8h-3v12h-4V10H7l5-8z',
    'Color': 'M7 3h10v2H7V3zm-2 4h14v14H5V7zm3 3v8h8v-8H8z',
    'Permanente': 'M7 5c2 0 2 2 4 2s2-2 4-2 2 2 4 2v2c-2 0-2-2-4-2s-2 2-4 2-2-2-4-2-2 2-4 2V7c2 0 2-2 4-2zm-2 8c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2v2c-2 0-2-2-4-2s-2 2-4 2-2-2-4-2-2 2-4 2v-2z'
  };
  return m[service] || m['Corte'];
}

function renderQueue(){
  const list = els.listaEspera;
  list.innerHTML = '';

  if (!state.queue.length){
    els.emptyState.hidden = false;
    return;
  }
  els.emptyState.hidden = true;

  const nowTs = Date.now();
  state.queue.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'qItem';
    li.dataset.id = item.id;

    const isNext = idx === 0;
    li.classList.toggle('isNext', isNext);
    li.classList.toggle('isReady', !!item.ready);

    const waitMin = Math.max(0, Math.round((item.startTs - nowTs) / 60000));

    li.innerHTML = `
      <div class="swipe">
        <button class="deleteBtn" type="button" aria-label="Eliminar">Eliminar</button>
        <div class="swipeCard" tabindex="0">
          <div class="qLeft">
            <div class="qIcon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="${iconForService(item.service)}"/></svg>
            </div>
          </div>
          <div class="qMid">
            <div class="qTop">
              <div class="qService">${item.service}</div>
              ${isNext ? `<span class="badge">PRÓXIMO</span>` : ''}
            </div>
            <div class="qSub">${item.speed} · ${item.plannedMin} min</div>
            <div class="qTimes">
              <span class="muted">Espera: ${waitMin}m</span>
              <span class="muted">Inicio ${formatClock(item.startTs)} / Fin ${formatClock(item.endTs)}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    // Swipe gestures
    attachSwipe(li, item);

    list.appendChild(li);
  });
}

function renderAddButtonClass(){
  els.btnAgregar.classList.remove('isOk','isWarn','isDanger');
  if (state.deadlineClass === 'ok') els.btnAgregar.classList.add('isOk');
  if (state.deadlineClass === 'warn') els.btnAgregar.classList.add('isWarn');
  if (state.deadlineClass === 'danger') els.btnAgregar.classList.add('isDanger');
}

// ---------- Swipe-to-delete (iOS style) ----------
function attachSwipe(li, item){
  const swipe = li.querySelector('.swipe');
  const card = li.querySelector('.swipeCard');
  const del = li.querySelector('.deleteBtn');

  let startX = 0;
  let currentX = 0;
  let dragging = false;
  let opened = false;

  const max = 92; // px

  function setX(x){
    const clamped = clamp(x, -max, 0);
    swipe.style.transform = `translateX(${clamped}px)`;
  }

  function close(){
    opened = false;
    swipe.classList.remove('open');
    setX(0);
  }

  function open(){
    opened = true;
    swipe.classList.add('open');
    setX(-max);
    feedback('tap');
  }

  function onStart(e){
    const t = e.touches ? e.touches[0] : e;
    dragging = true;
    startX = t.clientX;
    currentX = opened ? -max : 0;
    swipe.classList.add('dragging');
  }

  function onMove(e){
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e;
    const dx = t.clientX - startX;
    const x = currentX + dx;
    // Solo swipe izquierda
    if (x > 0) return;
    setX(x);
  }

  function onEnd(){
    if (!dragging) return;
    dragging = false;
    swipe.classList.remove('dragging');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(swipe).transform);
    const x = matrix.m41;
    if (x < -42) open();
    else close();
  }

  card.addEventListener('touchstart', onStart, {passive:true});
  card.addEventListener('touchmove', onMove, {passive:true});
  card.addEventListener('touchend', onEnd, {passive:true});
  card.addEventListener('touchcancel', onEnd, {passive:true});

  card.addEventListener('pointerdown', onStart);
  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', onEnd);
  card.addEventListener('pointercancel', onEnd);

  // tap outside to close
  document.addEventListener('touchstart', (e)=>{
    if (!opened) return;
    if (!li.contains(e.target)) close();
  }, {passive:true});

  del.addEventListener('click', () => {
    feedback('danger');
    // Smooth exit
    li.classList.add('leaving');
    setTimeout(() => {
      state.queue = state.queue.filter(q => q.id !== item.id);
      recalcQueue();
    }, 240);
  });
}

// ---------- Modals ----------
function openModal(modalEl){
  modalEl.hidden = false;
  modalEl.classList.add('isOpen');
  document.body.classList.add('modalOpen');
  feedback('tap');
}

function closeModal(modalEl){
  modalEl.classList.remove('isOpen');
  setTimeout(() => {
    modalEl.hidden = true;
  }, 170);
  document.body.classList.remove('modalOpen');
  feedback('tap');
}

// Add modal steps
function renderAddModal(){
  const speedWrap = els.bubblesVel;
  const srvWrap = els.bubblesSrv;

  // Step 1 bubbles
  const speeds = ['Rápido','Normal','Lento'];
  speedWrap.innerHTML = speeds.map(s => {
    const selected = state.addModalSpeed === s ? 'isSelected' : '';
    return `<button class="bubble ${selected}" type="button" data-speed="${s}">${s}</button>`;
  }).join('');

  // Step 2 bubbles
  const srv = serviceList();
  srvWrap.innerHTML = srv.map(x => {
    return `<button class="bubble bubble--wide" type="button" data-service="${x.key}">${x.key}</button>`;
  }).join('');

  // Show steps
  $('#addStep1').hidden = state.addModalStep !== 1;
  $('#addStep2').hidden = state.addModalStep !== 2;
}

function resetAddModal(){
  state.addModalStep = 1;
  state.addModalSpeed = null;
  renderAddModal();
}

// ---------- Records ----------
function addRegistro(entry){
  state.registro.unshift(entry);
  saveRegistro(state.registro);
}

function renderRegistro(){
  const list = state.registro;
  let totalMin = 0;
  for (const r of list){
    totalMin += Math.round(r.realMs/60000);
  }

  els.registroResumen.innerHTML = `
    <div class="sumCard">
      <div class="sumLine"><span class="muted">Total servicios</span><span class="sumVal">${list.length}</span></div>
      <div class="sumLine"><span class="muted">Tiempo total</span><span class="sumVal">${formatDurationHM(totalMin)}</span></div>
    </div>
  `;

  els.registroLista.innerHTML = list.map(r => {
    const mins = Math.round(r.realMs/60000);
    return `
      <li class="regItem">
        <div class="regTop">
          <div class="regSvc">${r.service}</div>
          <div class="regDur">${formatDurationHM(mins)}</div>
        </div>
        <div class="regSub muted">${formatClock(r.startTs)}-${formatClock(r.endTs)} · ${r.speed}</div>
      </li>
    `;
  }).join('');
}

async function copyRegistro(){
  const lines = [];
  const list = state.registro;
  let totalMin = 0;
  for (const r of list) totalMin += Math.round(r.realMs/60000);
  lines.push(`Registro - ${new Date().toLocaleDateString()}`);
  lines.push(`Total servicios: ${list.length}`);
  lines.push(`Tiempo total: ${formatDurationHM(totalMin)}`);
  lines.push('');
  for (const r of [...list].reverse()){
    const mins = Math.round(r.realMs/60000);
    lines.push(`${r.service} | ${formatClock(r.startTs)}-${formatClock(r.endTs)} | ${formatDurationHM(mins)} | ${r.speed}`);
  }
  const text = lines.join('\n');

  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado');
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copiado');
  }
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg){
  let el = $('#toast');
  if (!el){
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove('show'), 1200);
}

// ---------- Actions ----------
function startService(service, speed){
  const plannedMin = calcPlannedMinutes(service, speed);
  state.current = {
    service,
    speed,
    plannedMin,
    startTs: Date.now(),
    plannedMs: plannedMin*60*1000,
    overtimeNotified: false,
  };

  // when starting, if it was ready item, it already removed before call
  recalcQueue();
  startTimerLoop();
}

function finalizeCurrent(){
  if (!state.current) return;

  const nowTs = Date.now();
  const startTs = state.current.startTs;
  const entry = {
    service: state.current.service,
    speed: state.current.speed,
    startTs,
    endTs: nowTs,
    realMs: nowTs - startTs,
    plannedMin: state.current.plannedMin,
  };
  addRegistro(entry);

  // stop timer
  state.current = null;
  stopTimerLoop();

  // recalcular cola
  recalcQueue();

  // marcar primer item como "Siguiente listo" (no auto start)
  if (state.queue.length){
    state.queue[0].ready = true;
    // mantener planificación
    recalcQueue();
  }

  renderRegistro();
  tick();
}

function startReadyIfAny(){
  if (state.current) return;
  if (!state.queue.length) return;
  const first = state.queue[0];
  if (!first.ready) return;

  // remove first and start
  state.queue.shift();
  const {service, speed} = first;
  recalcQueue();
  startService(service, speed);
}

function willBeDangerIfAdd(service, speed){
  const nowTs = Date.now();
  const plannedMin = calcPlannedMinutes(service, speed);
  const newItemMs = plannedMin*60*1000;

  // compute end if added
  let lastEnd = getLastPlannedEndTs(nowTs);
  // If no current and no queue, and it would start now as current
  // planned end = now + planned
  if (!state.current && !state.queue.length) lastEnd = nowTs;

  const endAfter = lastEnd + newItemMs;
  return { endAfter, ...classifyDeadline(endAfter, nowTs) };
}

function addClientFlow(service, speed){
  const plannedMin = calcPlannedMinutes(service, speed);
  const item = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    service,
    speed,
    plannedMin,
    startTs: 0,
    endTs: 0,
    ready: false,
  };

  if (state.current){
    state.queue.push(item);
    recalcQueue();
  } else {
    // If no running service: inicia el servicio actual
    startService(service, speed);
  }
}

// ---------- Personalizar modal ----------
function fillPersonalizar(){
  const s = state.settings;
  els.inpCorte.value = s.base['Corte'];
  els.inpCorteBarba.value = s.base['Corte + Barba'];
  els.inpCorteBarbaSellado.value = s.base['Corte + Barba + Sellado'];
  els.inpColor.value = s.base['Color'];
  els.inpPermanente.value = s.base['Permanente'];

  els.inpDeltaRapido.value = s.deltaSellado['Rápido'];
  els.inpDeltaNormal.value = s.deltaSellado['Normal'];
  els.inpDeltaLento.value = s.deltaSellado['Lento'];

  els.inpAdjRapido.value = s.ajusteVelocidad['Rápido'];
  els.inpAdjNormal.value = s.ajusteVelocidad['Normal'];
  els.inpAdjLentoCorto.value = s.ajusteVelocidad['LentoCorto'];
  els.inpAdjLentoLargo.value = s.ajusteVelocidad['LentoLargo'];
}

function readPersonalizar(){
  const n = (v) => Number(v);
  return {
    base: {
      'Corte': n(els.inpCorte.value),
      'Corte + Barba': n(els.inpCorteBarba.value),
      'Corte + Barba + Sellado': n(els.inpCorteBarbaSellado.value),
      'Color': n(els.inpColor.value),
      'Permanente': n(els.inpPermanente.value),
    },
    deltaSellado: {
      'Rápido': n(els.inpDeltaRapido.value),
      'Normal': n(els.inpDeltaNormal.value),
      'Lento': n(els.inpDeltaLento.value),
    },
    ajusteVelocidad: {
      'Rápido': n(els.inpAdjRapido.value),
      'Normal': n(els.inpAdjNormal.value),
      'LentoCorto': n(els.inpAdjLentoCorto.value),
      'LentoLargo': n(els.inpAdjLentoLargo.value),
    }
  };
}

function sanitizeSettings(s){
  const safe = structuredClone(DEFAULT_SETTINGS);
  for (const k of Object.keys(safe.base)) safe.base[k] = Math.max(1, Math.round(Number(s.base[k])));
  for (const k of Object.keys(safe.deltaSellado)) safe.deltaSellado[k] = Math.max(0, Math.round(Number(s.deltaSellado[k])));
  safe.ajusteVelocidad['Rápido'] = Math.round(Number(s.ajusteVelocidad['Rápido']));
  safe.ajusteVelocidad['Normal'] = Math.round(Number(s.ajusteVelocidad['Normal']));
  safe.ajusteVelocidad['LentoCorto'] = Math.round(Number(s.ajusteVelocidad['LentoCorto']));
  safe.ajusteVelocidad['LentoLargo'] = Math.round(Number(s.ajusteVelocidad['LentoLargo']));
  return safe;
}

// ---------- Event listeners ----------
function wire(){
  // Prevent iOS gesture zoom / weird UI
  ['gesturestart','gesturechange','gestureend'].forEach(evt => {
    document.addEventListener(evt, (e)=>{ e.preventDefault(); }, {passive:false});
  });

  // Central button
  els.btnCentral.addEventListener('click', () => {
    feedback('tap');
    if (state.current){
      // FINALIZAR
      finalizeCurrent();
    } else {
      // INICIAR: only if first ready
      startReadyIfAny();
    }
  });

  // Add button
  els.btnAgregar.addEventListener('click', () => {
    // open modal
    resetAddModal();
    openModal(els.modalAgregar);
  });

  // Topbar
  els.btnRegistro.addEventListener('click', () => {
    renderRegistro();
    openModal(els.modalRegistro);
  });
  els.btnPersonalizar.addEventListener('click', () => {
    fillPersonalizar();
    openModal(els.modalPersonalizar);
  });

  // Close modal buttons
  els.addCerrar.addEventListener('click', () => closeModal(els.modalAgregar));
  els.personalizarCerrar.addEventListener('click', () => closeModal(els.modalPersonalizar));
  els.registroCerrar.addEventListener('click', () => closeModal(els.modalRegistro));

  // Backdrop click
  [els.modalAgregar, els.modalPersonalizar, els.modalRegistro].forEach(modal => {
    modal.addEventListener('click', (e)=>{
      if (e.target === modal) closeModal(modal);
    });
  });

  // Add modal selection
  els.bubblesVel.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-speed]');
    if (!btn) return;
    feedback('tap');
    state.addModalSpeed = btn.dataset.speed;
    state.addModalStep = 2;
    renderAddModal();
  });

  els.bubblesSrv.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-service]');
    if (!btn) return;
    if (!state.addModalSpeed) return;

    feedback('tap');
    const service = btn.dataset.service;
    const speed = state.addModalSpeed;

    // Confirm if would be danger
    const check = willBeDangerIfAdd(service, speed);
    if (check.cls === 'danger'){
      const limitTs = check.limitTs;
      const msg = `Terminarías ${formatClock(check.endAfter)} (límite ${formatClock(limitTs)}). ¿Agregar igual?`;
      const ok = confirm(msg);
      if (!ok) return;
    }

    closeModal(els.modalAgregar);
    addClientFlow(service, speed);
    recalcQueue();
  });

  // Personalizar actions
  els.btnRestoreDefaults.addEventListener('click', () => {
    feedback('tap');
    state.settings = structuredClone(DEFAULT_SETTINGS);
    saveSettings(state.settings);
    fillPersonalizar();
    recalcQueue();
    toast('Restaurado');
  });

  els.btnGuardarPersonalizar.addEventListener('click', () => {
    feedback('tap');
    const raw = readPersonalizar();
    state.settings = sanitizeSettings(raw);
    saveSettings(state.settings);
    recalcQueue();
    toast('Guardado');
    closeModal(els.modalPersonalizar);
  });

  // Registro actions
  els.btnCopiarRegistro.addEventListener('click', () => {
    feedback('tap');
    copyRegistro();
  });

  els.btnBorrarRegistro.addEventListener('click', () => {
    feedback('danger');
    const ok = confirm('¿Borrar registro?');
    if (!ok) return;
    state.registro = [];
    saveRegistro(state.registro);
    renderRegistro();
  });

  // Keep app stable: prevent sideways pan
  document.addEventListener('touchmove', (e)=>{
    // Allow scroll only inside scrollable sheets
    const allow = e.target.closest('.modal__sheet--scroll');
    if (!allow) e.preventDefault();
  }, {passive:false});
}

// ---------- PWA ----------
function registerSW(){
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch {
      // silent
    }
  });
}

// ---------- Init ----------
function init(){
  renderAddModal();
  recalcQueue();
  tick();
  wire();
  registerSW();

  // If there is a queue and app starts idle, nothing is ready until a finalize event;
  // we keep it strict to spec ("Siguiente listo" is set after finalizar).

  // Update time-based UI every minute
  setInterval(()=>{
    recalcQueue();
    tick();
  }, 60000);
}

init();
