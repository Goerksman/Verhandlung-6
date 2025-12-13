/* ========================================================================== */
/* Konfiguration via URL                                                     */
/* ========================================================================== */
const Q = new URLSearchParams(location.search);
const CONFIG = {
  INITIAL_OFFER: Number(Q.get('i')) || 5500,
  MIN_PRICE: Q.has('min') ? Number(Q.get('min')) : undefined,
  MIN_PRICE_FACTOR: Number(Q.get('mf')) || 0.70,
  ACCEPT_MARGIN: Number(Q.get('am')) || 0.12,
  ROUNDS_MIN: parseInt(Q.get('rmin') || '8', 10),
  ROUNDS_MAX: parseInt(Q.get('rmax') || '12', 10),
  THINK_DELAY_MS_MIN: parseInt(Q.get('tmin') || '1200', 10),
  THINK_DELAY_MS_MAX: parseInt(Q.get('tmax') || '2800', 10),
  ACCEPT_RANGE_MIN: Number(Q.get('armin')) || 4700,
  ACCEPT_RANGE_MAX: Number(Q.get('armax')) || 4800
};
CONFIG.MIN_PRICE = Number.isFinite(CONFIG.MIN_PRICE)
  ? CONFIG.MIN_PRICE
  : Math.round(CONFIG.INITIAL_OFFER * CONFIG.MIN_PRICE_FACTOR);

/* ========================================================================== */
/* Spieler-ID / Probandencode                                                 */
/* ========================================================================== */
if (!window.playerId) {
  const fromUrl =
    Q.get('player_id') ||
    Q.get('playerId') ||
    Q.get('pid') ||
    Q.get('id');

  window.playerId = fromUrl || ('P_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
}

if (!window.probandCode) {
  const fromUrlCode =
    Q.get('proband_code') ||
    Q.get('probandCode') ||
    Q.get('code');

  window.probandCode = fromUrlCode || window.playerId;
}

/* ========================================================================== */
/* Konstanten                                                                 */
/* ========================================================================== */
const UNACCEPTABLE_LIMIT = 2250;
const EXTREME_BASE = 1500;
const ABSOLUTE_FLOOR = 3500;

const BASE_INITIAL_OFFER = CONFIG.INITIAL_OFFER;
const BASE_MIN_PRICE     = CONFIG.MIN_PRICE;
const BASE_STEP_AMOUNT   = 0;

const DIMENSION_FACTORS = [1.0, 1.3, 1.5];
let dimensionQueue = [];

function refillDimensionQueue() {
  dimensionQueue = [...DIMENSION_FACTORS];
  for (let i = dimensionQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [dimensionQueue[i], dimensionQueue[j]] = [dimensionQueue[j], dimensionQueue[i]];
  }
}

function nextDimensionFactor() {
  if (dimensionQueue.length === 0) refillDimensionQueue();
  return dimensionQueue.pop();
}

const app = document.getElementById('app');

const randInt = (a,b) => Math.floor(a + Math.random()*(b-a+1));
const eur = n => new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR'}).format(n);
const roundToNearest50 = (v) => Math.round(v / 50) * 50;

/* ========================================================================== */
/* Zustand                                                                    */
/* ========================================================================== */
function newState(){
  const factor = nextDimensionFactor();

  const floorRaw      = ABSOLUTE_FLOOR * factor;
  const floorRounded  = roundToNearest50(floorRaw);

  const initialRaw    = 3728 * factor;
  const initialOffer  = Math.round(initialRaw);

  return {
    participant_id: crypto.randomUUID?.() || ('x_'+Date.now()+Math.random().toString(36).slice(2)),
    runde: 1,
    max_runden: randInt(CONFIG.ROUNDS_MIN, CONFIG.ROUNDS_MAX),

    scale_factor: factor,
    step_amount: 0,

    min_price: floorRounded,
    max_price: initialOffer,
    initial_offer: initialOffer,
    current_offer: initialOffer,

    history: [],
    last_concession: null,
    finished: false,
    accepted: false,

    patternMessage: '',
    deal_price: null,
    finish_reason: null,
    last_abort_chance: 0
  };
}

let state = newState();

/* ========================================================================== */
/* Logging                                                                    */
/* ========================================================================== */
function logRound(row) {
  const payload = {
    participant_id: state.participant_id,
    player_id: window.playerId,
    proband_code: window.probandCode,
    scale_factor: state.scale_factor,

    runde: row.runde,
    algo_offer: row.algo_offer,
    proband_counter: row.proband_counter,
    accepted: row.accepted,
    finished: row.finished,
    deal_price: row.deal_price
  };

  if (window.sendRow) window.sendRow(payload);
  else console.log('[sendRow fallback]', payload);
}

/* ========================================================================== */
/* Auto-Accept                                                                */
/* ========================================================================== */
function shouldAutoAccept(initialOffer, minPrice, prevOffer, counter){
  const c = Number(counter);
  if (!Number.isFinite(c)) return false;

  const f = state.scale_factor;

  if (Math.abs(prevOffer - c) <= prevOffer * 0.05) return true;

  const accMin = CONFIG.ACCEPT_RANGE_MIN * f;
  const accMax = CONFIG.ACCEPT_RANGE_MAX * f;
  if (c >= accMin && c <= accMax) return true;

  const threshold = Math.max(minPrice, initialOffer * (1 - CONFIG.ACCEPT_MARGIN));
  return c >= threshold;
}

/* ========================================================================== */
/* **NEUE ABBRUCHWAHRSCHEINLICHKEIT – MODELL A**                             */
/* ========================================================================== */

function abortProbability(seller, buyer) {
  const f = state.scale_factor;
  const diff = Math.abs(seller - buyer);

  if (diff >= 1000 * f) return 40;
  if (diff >= 750  * f) return 30;
  if (diff >= 500  * f) return 20;
  if (diff >= 250  * f) return 10;
  if (diff >= 100  * f) return 5;

  return 0;
}

function maybeAbort(userOffer) {
  const buyer  = Number(userOffer);
  const seller = state.current_offer;
  const f = state.scale_factor;

  if (buyer < 1500 * f) {
    state.last_abort_chance = 100;

    logRound({
      runde: state.runde,
      algo_offer: seller,
      proband_counter: buyer,
      accepted: false,
      finished: true,
      deal_price: ''
    });

    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'abort';
    viewAbort(100);
    return true;
  }

  const chance = abortProbability(seller, buyer);
  state.last_abort_chance = chance;

  const roll = randInt(1, 100);
  if (roll <= chance) {

    logRound({
      runde: state.runde,
      algo_offer: seller,
      proband_counter: buyer,
      accepted: false,
      finished: true,
      deal_price: ''
    });

    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'abort';
    viewAbort(chance);
    return true;
  }

  return false;
}

/* ========================================================================== */
/* Mustererkennung                                                            */
/* ========================================================================== */
function getThresholdForAmount(prev){
  const f = state.scale_factor;

  const A = 2250 * f;
  const B = 3000 * f;
  const C = 4000 * f;
  const D = 5000 * f;

  if (prev >= A && prev < B) return 0.05;
  if (prev >= B && prev < C) return 0.04;
  if (prev >= C && prev < D) return 0.03;
  return null;
}

function updatePatternMessage(){
  const f = state.scale_factor;
  const limit = UNACCEPTABLE_LIMIT * f;

  const counters = [];
  for (let h of state.history) {
    const c = Number(h.proband_counter);
    if (!Number.isFinite(c)) continue;
    if (c < limit) continue;
    counters.push(c);
  }

  if (counters.length < 3) {
    state.patternMessage = '';
    return;
  }

  let chain = 1;
  for (let i = 1; i < counters.length; i++) {
    const diff = counters[i] - counters[i-1];
    if (diff < 0) { chain = 1; continue; }

    const threshold = getThresholdForAmount(counters[i-1]);
    if (threshold == null) { chain = 1; continue; }

    if (diff <= counters[i-1] * threshold) chain++;
    else chain = 1;
  }

  state.patternMessage =
    chain >= 3
      ? 'Mit solchen kleinen Erhöhungen wird das schwierig. Geh bitte ein Stück näher an deine Schmerzgrenze, dann finden wir bestimmt schneller einen fairen Deal.'
      : '';
}

/* ========================================================================== */
/* Angebotslogik (konstantes Angebot)                                         */
/* ========================================================================== */
function computeNextOffer(prevOffer, minPrice){
  const prev = Number(prevOffer);
  return Math.max(minPrice, prev);
}

/* ========================================================================== */
/* Rendering – Vignette                                                       */
/* ========================================================================== */
function viewVignette(){
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <p class="muted">Stelle dir folgende Situation vor:</p>
    <p>
      Ein Verkäufer bietet eine <b>hochwertige Designer-Ledercouch</b> auf einer Möbelmesse an.
      Vergleichbare Sofas liegen zwischen <b>2.500 €</b> und <b>10.000 €</b>.
    </p>
    <p>
      Du verhandelst über den Verkaufspreis, aber der Verkäufer besitzt eine klare Preisuntergrenze.
    </p>
    <p class="muted"> 
      Die Verhandlung dauert zufällig ${CONFIG.ROUNDS_MIN}–${CONFIG.ROUNDS_MAX} Runden.
    </p>
    <div class="grid">
      <label class="consent">
        <input id="consent" type="checkbox" />
        <span>Ich stimme zu, dass meine Eingaben anonym gespeichert werden.</span>
      </label>
      <div>
        <button id="startBtn" disabled>Verhandlung starten</button>
      </div>
    </div>`;

  document.getElementById('consent').onchange =
    e => document.getElementById('startBtn').disabled = !e.target.checked;

  document.getElementById('startBtn').onclick = () => {
    state = newState();
    viewNegotiate();
  };
}

/* ========================================================================== */
/* Rendering – Think Screen                                                   */
/* ========================================================================== */
function viewThink(next){
  const d = randInt(CONFIG.THINK_DELAY_MS_MIN, CONFIG.THINK_DELAY_MS_MAX);
  app.innerHTML = `
    <h1>Die Verkäuferseite überlegt<span class="pulse">…</span></h1>
    <p class="muted">Bitte warten.</p>`;
  setTimeout(next, d);
}

/* ========================================================================== */
/* Rendering – Verlaufstabelle                                                */
/* ========================================================================== */
function historyTable(){
  if (!state.history.length) return '';
  return `
    <h2>Verlauf</h2>
    <table>
      <thead><tr>
        <th>Runde</th><th>Angebot Verkäufer</th><th>Gegenangebot</th><th>Angenommen?</th>
      </tr></thead>
      <tbody>
        ${state.history.map(h => `
          <tr>
            <td>${h.runde}</td>
            <td>${eur(h.algo_offer)}</td>
            <td>${h.proband_counter != null ? eur(h.proband_counter) : '-'}</td>
            <td>${h.accepted ? 'Ja' : 'Nein'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

/* ========================================================================== */
/* Rendering – Abbruch                                                        */
/* ========================================================================== */
function viewAbort(chance){
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card">
      <strong>Die Verkäuferseite hat die Verhandlung beendet.</strong>
      <p class="muted">Abbruchwahrscheinlichkeit in dieser Runde: ${chance}%</p>
    </div>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById('surveyBtn');
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        'https://docs.google.com/forms/d/e/1FAIpQLSer8gWrQ0hr4Nkygt9vaXsgGGA36JwYdFt3a4ClYDQWgnWQIw/viewform?usp=dialog';
    };
  }
}

/* ========================================================================== */
/* Rendering – Hauptscreen                                                    */
/* ========================================================================== */
function viewNegotiate(errorMsg){
  const abortChance = state.last_abort_chance;

  let color = '#16a34a';
  if (abortChance > 50) color = '#ea580c';
  else if (abortChance > 25) color = '#eab308';

  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="border:1px dashed var(--accent);">
      <strong>Aktuelles Angebot:</strong> ${eur(state.current_offer)}
    </div>

    <div style="
      background:${color}22;
      border-left:6px solid ${color};
      padding:10px;
      border-radius:8px;">
      <b style="color:${color};">Abbruchwahrscheinlichkeit:</b>
      <span style="color:${color}; font-weight:600;">${abortChance}%</span>
    </div>

    <label for="counter">Dein Gegenangebot (€)</label>
    <input id="counter" type="number" step="1" min="0">

    <button id="sendBtn">Gegenangebot senden</button>
    <button id="acceptBtn" class="ghost">Angebot annehmen</button>

    ${historyTable()}
    ${state.patternMessage ? `<p>${state.patternMessage}</p>` : ''}
    ${errorMsg ? `<p class="error">${errorMsg}</p>` : ''}
  `;

  document.getElementById('sendBtn').onclick =
    () => handleSubmit(document.getElementById('counter').value);

  document.getElementById('counter').onkeydown =
    e => { if (e.key === "Enter") handleSubmit(e.target.value); };

  document.getElementById('acceptBtn').onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted: true
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      deal_price: state.current_offer
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = state.current_offer;

    viewThink(() => viewFinish(true));
  };
}

/* ========================================================================== */
/* Handle Submit                                                              */
/* ========================================================================== */
function handleSubmit(raw){
  let num = Number(raw.toString().trim().replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) {
    return viewNegotiate('Bitte eine gültige Zahl ≥ 0 eingeben.');
  }

  num = Math.round(num);

  const prevOffer = state.current_offer;
  const f = state.scale_factor;

  if (shouldAutoAccept(state.initial_offer, state.min_price, prevOffer, num)) {

    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true
    });

    logRound({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true,
      finished: true,
      deal_price: num
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = num;

    return viewThink(() => viewFinish(true));
  }

  if (num < EXTREME_BASE * f) {

    state.last_abort_chance = 100;

    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: false
    });

    logRound({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: false,
      finished: true,
      deal_price: ''
    });

    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'abort';

    return viewAbort(100);
  }

  if (maybeAbort(num)) return;

  const next = computeNextOffer(prevOffer, state.min_price);
  const concession = prevOffer - next;

  logRound({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false,
    finished: false,
    deal_price: ''
  });

  state.history.push({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false
  });

  updatePatternMessage();

  state.current_offer = next;
  state.last_concession = concession;

  if (state.runde >= state.max_runden) {
    state.finished = true;
    state.finish_reason = 'max_rounds';
    return viewThink(() => viewDecision());
  }

  state.runde++;
  return viewThink(() => viewNegotiate());
}

/* ========================================================================== */
/* Rendering – letzte Runde                                                   */
/* ========================================================================== */
function viewDecision(){
  app.innerHTML = `
    <h1>Letzte Runde</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card">
      <strong>Letztes Angebot:</strong> ${eur(state.current_offer)}
    </div>

    <button id="takeBtn">Annehmen</button>
    <button id="noBtn" class="ghost">Ablehnen</button>

    ${historyTable()}
  `;

  document.getElementById('takeBtn').onclick = () => {

    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted:true
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      deal_price: state.current_offer
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = state.current_offer;

    viewThink(() => viewFinish(true));
  };

  document.getElementById('noBtn').onclick = () => {

    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted:false
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: false,
      finished: true,
      deal_price: ''
    });

    state.accepted = false;
    state.finished = true;
    state.finish_reason = 'max_rounds';

    viewThink(() => viewFinish(false));
  };
}

/* ========================================================================== */
/* Rendering – Endscreen                                                      */
/* ========================================================================== */
function viewFinish(accepted){
  const deal = state.deal_price ?? state.current_offer;

  let text = '';
  if (accepted) text = `Einigung in Runde ${state.runde} bei ${eur(deal)}.`;
  else if (state.finish_reason === 'abort') text = `Verhandlung vom Verkäufer abgebrochen.`;
  else text = `Maximale Runden erreicht.`;

  app.innerHTML = `
    <h1>Verhandlung abgeschlossen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card">
      <strong>Ergebnis:</strong> ${text}
    </div>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById('surveyBtn');
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href = 'https://docs.google.com/forms/d/e/1FAIpQLSer8gWrQ0hr4Nkygt9vaXsgGGA36JwYdFt3a4ClYDQWgnWQIw/viewform?usp=dialog';
    };
  }
}

/* ========================================================================== */
/* Start                                                                      */
/* ========================================================================== */
viewVignette();
