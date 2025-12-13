/* ========================================================================== */
/* Konfiguration via URL                                                     */
/* ========================================================================== */
const Q = new URLSearchParams(location.search);

const CONFIG = {
  // Startangebot jetzt 3782, falls nicht per URL überschrieben
  INITIAL_OFFER: Number(Q.get("i")) || 3782,

  // optional direkt setzen (?min=...). Für diesen Stil setzen wir min intern = INITIAL_OFFER,
  // der URL-Wert kann aber trotzdem eingelesen werden falls du ihn später brauchst.
  MIN_PRICE: Q.has("min") ? Number(Q.get("min")) : undefined,
  MIN_PRICE_FACTOR: Number(Q.get("mf")) || 0.7,

  // Zufällige Rundenzahl 8–12 (optional über rmin/rmax konfigurierbar)
  ROUNDS_MIN: parseInt(Q.get("rmin") || "8", 10),
  ROUNDS_MAX: parseInt(Q.get("rmax") || "12", 10),

  THINK_DELAY_MS_MIN: parseInt(Q.get("tmin") || "1200", 10),
  THINK_DELAY_MS_MAX: parseInt(Q.get("tmax") || "2800", 10),
};

// Mindestpreis finalisieren (Fallback über Faktor – wird gleich aber auf Startangebot gesetzt)
CONFIG.MIN_PRICE = Number.isFinite(CONFIG.MIN_PRICE)
  ? CONFIG.MIN_PRICE
  : Math.round(CONFIG.INITIAL_OFFER * CONFIG.MIN_PRICE_FACTOR);

/* ============================================================
   HILFSFUNKTIONEN
============================================================ */

const roundEuro = (n) => Math.round(Number(n));
const randInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const eur = (n) =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(roundEuro(n));

const app = document.getElementById("app");

/* ============================================================
   DIMENSIONSSYSTEM
============================================================ */

const DIM_FACTORS = [1.0, 1.3, 1.5];
let DIM_QUEUE = [];

function shuffleDimensions() {
  DIM_QUEUE = [...DIM_FACTORS];
  for (let i = DIM_QUEUE.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [DIM_QUEUE[i], DIM_QUEUE[j]] = [DIM_QUEUE[j], DIM_QUEUE[i]];
  }
}

function nextDimension() {
  if (DIM_QUEUE.length === 0) shuffleDimensions();
  return DIM_QUEUE.pop();
}

/* ============================================================
   SPIELZUSTAND
============================================================ */

function newState() {
  const f = nextDimension();

  // Referenzwert 3782 wird mit f multipliziert und auf den Euro gerundet
  const baseStart = roundEuro(CONFIG.INITIAL_OFFER * f);

  // In diesem Treatment: Schmerzgrenze = Startangebot (kein Nachgeben)
  const baseMin = baseStart;

  return {
    participant_id: crypto.randomUUID?.() || "v_" + Date.now(),

    runde: 1,
    max_runden: randInt(CONFIG.ROUNDS_MIN, CONFIG.ROUNDS_MAX),

    scale: f,

    initial_offer: baseStart,
    current_offer: baseStart,
    min_price: baseMin,

    history: [],
    accepted: false,
    finished: false,

    // Warn-/Patternzustand
    patternMessage: "",
    last_abort_chance: null, // für Anzeige
    warningRounds: 0,        // wie viele Runden in Folge "kleine Schritte" erkannt werden
  };
}

let state = newState();

/* ============================================================
   AUTO-ACCEPT LOGIK
============================================================ */

function shouldAccept(userOffer) {
  const buyer = roundEuro(userOffer);
  const seller = state.current_offer;
  const f = state.scale;

  // 1) Käufer-Angebot ≥ aktuelles Verkäuferangebot
  if (buyer >= seller) return true;

  // 2) Käufer liegt innerhalb von 5 % am Verkäuferangebot
  if (Math.abs(seller - buyer) / seller <= 0.05) return true;

  // 3) Absolute Schwelle (mit Dimension skaliert)
  if (buyer >= roundEuro(5000 * f)) return true;

  // 4) Letzte Runde (oder vorletzte) und Käufer ist mindestens bei min_price
  if (state.max_runden - state.runde <= 1 && buyer >= state.min_price)
    return true;

  return false;
}

// Wrapper für Kompatibilität
function shouldAutoAccept(_initialOffer, _minPrice, _prevOffer, counter) {
  return shouldAccept(counter);
}

/* ============================================================
   VERKÄUFER-UPDATE – KONSTANTES ANGEBOT
   -> Algorithmus bleibt in jeder Runde beim selben Preis
============================================================ */

function computeNextOffer(_userOffer) {
  // Kein Nachgeben: Angebot bleibt immer gleich
  return state.current_offer;
}

/* ============================================================
   PATTERNERKENNUNG (kleine Schritte) + Warntext
============================================================ */

function updatePatternState(currentBuyerOffer) {
  const f = state.scale;
  const minRelevant = roundEuro(2250 * f);
  const SMALL = roundEuro(100 * f);
  const buyer = roundEuro(currentBuyerOffer);

  // außerhalb 1–4: keinerlei Pattern-Aufbau
  if (state.runde > 4) {
    state.warningRounds = 0;
    state.patternMessage = "";
    return;
  }

  const last = state.history[state.history.length - 1];

  if (last && last.proband_counter != null) {
    const lastBuyer = roundEuro(last.proband_counter);

    // nur wenn beide Angebote im relevanten Bereich liegen
    if (buyer >= minRelevant && lastBuyer >= minRelevant) {
      const stepUp = buyer - lastBuyer;
      if (stepUp > 0 && stepUp < SMALL) {
        // kleine Erhöhung → Warnkette verlängern
        state.warningRounds = (state.warningRounds || 0) + 1;
      } else {
        // kein kleines Schrittmuster → Kette bricht ab
        state.warningRounds = 0;
      }
    } else {
      state.warningRounds = 0;
    }
  } else {
    // keine Vergleichsbasis
    state.warningRounds = 0;
  }

  if (state.warningRounds > 0) {
    state.patternMessage =
      "Mit derart kleinen Erhöhungen kommen wir eher unwahrscheinlich zu einer Einigung.";
  } else {
    state.patternMessage = "";
  }
}

/* ============================================================
   RISIKO-SYSTEM
============================================================ */

function abortProbabilityFromLastDifference(sellerOffer, buyerOffer) {
  const f = state.scale || 1.0;

  const diff = Math.abs(roundEuro(sellerOffer) - roundEuro(buyerOffer));

  // Referenz: 3000 € → 30 % (skaliert mit f)
  const BASE_DIFF = 3000 * f;

  let chance = (diff / BASE_DIFF) * 30;

  if (chance < 0) chance = 0;
  if (chance > 100) chance = 100;

  return Math.round(chance);
}

function maybeAbort(userOffer) {
  const f = state.scale;
  const seller = state.current_offer;
  const buyer = roundEuro(userOffer);

  // 1) Extrem-Lowball: unter 1500 * f → immer Abbruch, auch in Runde 1
  if (buyer < roundEuro(1500 * f)) {
    state.last_abort_chance = 100;

    logRound({
      runde: state.runde,
      algo_offer: seller,
      proband_counter: buyer,
      accepted: false,
      finished: true,
      deal_price: "",
    });

    state.history.push({
      runde: state.runde,
      algo_offer: seller,
      proband_counter: buyer,
      accepted: false,
    });

    state.finished = true;
    state.accepted = false;

    viewAbort(100);
    return true;
  }

  // 2) Runde 1: KEIN Abbruch (außer Extremfall oben),
  //    aber Risiko zur Anzeige berechnen
  if (state.runde === 1) {
    const baseChance = abortProbabilityFromLastDifference(seller, buyer);
    state.last_abort_chance = baseChance;
    return false;
  }

  // 3) Ab Runde 2: Basis-Risiko über Differenz
  let chance = abortProbabilityFromLastDifference(seller, buyer);

  // 4) Zusatzrisiko aus "kleine Schritte"-Verhalten,
  //    nur in den ersten 4 Runden relevant.
  if (state.runde <= 4 && state.warningRounds > 0) {
    const extra = 7 + (state.warningRounds - 1) * 3;
    chance = Math.min(chance + extra, 100);
  }

  state.last_abort_chance = chance;

  const roll = randInt(1, 100);

  if (roll <= chance) {
    logRound({
      runde: state.runde,
      algo_offer: seller,
      proband_counter: buyer,
      accepted: false,
      finished: true,
      deal_price: "",
    });

    state.history.push({
      runde: state.runde,
      algo_offer: seller,
      proband_counter: buyer,
      accepted: false,
    });

    state.finished = true;
    state.accepted = false;

    viewAbort(chance);
    return true;
  }

  return false;
}

/* ============================================================
   LOGGING
============================================================ */

function logRound(row) {
  if (window.sendRow) {
    window.sendRow({
      participant_id: state.participant_id,
      player_id: window.playerId,
      proband_code: window.probandCode,
      ...row,
    });
  }
}

/* ============================================================
   HISTORY
============================================================ */

function historyTable() {
  if (!state.history.length) return "";
  const rows = state.history
    .map(
      (h) => `
      <tr>
        <td>${h.runde}</td>
        <td>${eur(h.algo_offer)}</td>
        <td>${
          h.proband_counter != null && h.proband_counter !== ""
            ? eur(h.proband_counter)
            : "-"
        }</td>
        <td>${h.accepted ? "Ja" : "Nein"}</td>
      </tr>
    `
    )
    .join("");

  return `
    <h2>Verlauf</h2>
    <table>
      <thead>
        <tr><th>Runde</th><th>Angebot Verkäufer</th><th>Gegenangebot</th><th>Angenommen?</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* ============================================================
   SCREENS
============================================================ */

function viewVignette(){
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <p class="muted">Stelle dir folgende Situation vor:</p>
    <p>
      Ein Verkäufer bietet eine <b>hochwertige Designer-Ledercouch</b> auf einer Möbelmesse an.
      Solche Möbel werden üblicherweise im <b>gehobenen Preissegment €</b> gehandelt, da sie aus wertvollem 
      Material bestehen und in der Regel Einzelstücke sind. Den Rahmen des Preises siehst du in der Verhandlung. 
    </p>
    <p>
      Du verhandelst mit dem Verkäufer über den endgültigen Verkaufspreis. 
    </p>
    <p class="muted"> 
      <b>Hinweis:</b> Die Verhandlung dauert zufällig ${CONFIG.ROUNDS_MIN}–${CONFIG.ROUNDS_MAX} Runden.
      Dein Verhalten beeinflusst das <b>Abbruchrisiko</b>: unangemessen niedrige oder kaum veränderte
      Angebote können zu einem vorzeitigen Abbruch führen.
    </p>
    <div class="grid">
      <label class="consent">
        <input id="consent" type="checkbox" />
        <span>Ich stimme zu, dass meine Eingaben anonym gespeichert werden.</span>
      </label>
      <div><button id="startBtn" disabled>Verhandlung starten</button></div>
    </div>`;

  document.getElementById("consent").onchange = () =>
    (document.getElementById("startBtn").disabled =
      !document.getElementById("consent").checked);

  document.getElementById("startBtn").onclick = () => {
    state = newState();
    viewNegotiate();
  };
}

function viewThink(next) {
  const delay = randInt(CONFIG.THINK_DELAY_MS_MIN, CONFIG.THINK_DELAY_MS_MAX);
  app.innerHTML = `
    <h1>Die Verkäuferseite überlegt<span class="pulse">…</span></h1>
    <p class="muted">Bitte warten.</p>
  `;
  setTimeout(next, delay);
}

function viewAbort(chance) {
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Die Verkäuferseite hat die Verhandlung beendet, da er mit Ihrem Gegenangebot nicht zufrieden war.</strong>
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

  document.getElementById("restartBtn").onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById("surveyBtn");
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        "https://docs.google.com/forms/d/e/1FAIpQLSddfk3DSXkwip_fTDijypc-QqpLYOfOlN45s4QouumBLyLLLA/viewform?usp=publish-editor";
    };
  }
}

function viewNegotiate(errorMsg) {
  const abortChance =
    typeof state.last_abort_chance === "number"
      ? state.last_abort_chance
      : null;

  let color = "#16a34a";
  if (abortChance !== null) {
    if (abortChance > 50) color = "#ea580c";
    else if (abortChance > 25) color = "#eab308";
  }

  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>
    <p class="muted">Spieler-ID: ${window.playerId ?? "-"}</p>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="grid">

      <div class="card" style="padding:16px;border:1px dashed var(--accent);">
        <strong>Aktuelles Angebot:</strong> ${eur(state.current_offer)}
      </div>

      <div style="
        background:${color}22;
        border-left:6px solid ${color};
        padding:10px;
        border-radius:8px;
        margin-bottom:10px;">
        <b style="color:${color};">Abbruchwahrscheinlichkeit:</b>
        <span style="color:${color}; font-weight:600;">
          ${abortChance !== null ? abortChance + "%" : "--"}
        </span>
      </div>

      ${
        state.patternMessage
          ? `<p class="error">${state.patternMessage}</p>`
          : ""
      }

      <label for="counter">Dein Gegenangebot (€)</label>
      <div class="row">
        <input id="counter" type="number" step="1" min="0" />
        <button id="sendBtn">Gegenangebot senden</button>
      </div>

      <button id="acceptBtn" class="ghost">Angebot annehmen</button>
    </div>

    ${historyTable()}
    ${errorMsg ? `<p class="error">${errorMsg}</p>` : ""}
  `;

  const inputEl = document.getElementById("counter");
  inputEl.onkeydown = (e) => {
    if (e.key === "Enter") handleSubmit(inputEl.value);
  };
  document.getElementById("sendBtn").onclick = () =>
    handleSubmit(inputEl.value);

  document.getElementById("acceptBtn").onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted: true,
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: "",
      accepted: true,
      finished: true,
      deal_price: state.current_offer,
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = state.current_offer;

    viewThink(() => viewFinish(true));
  };
}

/* ============================================================
   HANDLE SUBMIT
============================================================ */

function handleSubmit(raw) {
  const val = String(raw ?? "").trim().replace(",", ".");
  const parsed = Number(val);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return viewNegotiate("Bitte eine gültige Zahl ≥ 0 eingeben.");
  }

  const num = roundEuro(parsed);

  // keine niedrigeren Angebote als in der Vorrunde erlauben
  const last = state.history[state.history.length - 1];
  if (last && last.proband_counter != null) {
    const lastBuyer = roundEuro(last.proband_counter);
    if (num < lastBuyer) {
      return viewNegotiate(
        `Dein Gegenangebot darf nicht niedriger sein als in der Vorrunde (${eur(
          lastBuyer
        )}).`
      );
    }
  }

  const prevOffer = state.current_offer;

  // Auto-Accept
  if (shouldAutoAccept(state.initial_offer, state.min_price, prevOffer, num)) {
    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true,
    });

    logRound({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true,
      finished: true,
      deal_price: num,
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = num;

    return viewThink(() => viewFinish(true));
  }

  // Pattern-State mit dem aktuellen Angebot aktualisieren
  updatePatternState(num);

  // Abbruch prüfen (nutzt warningRounds, setzt last_abort_chance)
  if (maybeAbort(num)) return;

  // normale Runde – Verkäufer bleibt beim gleichen Angebot
  const next = computeNextOffer(num);

  logRound({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false,
    finished: false,
    deal_price: "",
  });

  state.history.push({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false,
  });

  state.current_offer = next; // bleibt konstant

  if (state.runde >= state.max_runden) {
    state.finished = true;
    return viewThink(() => viewDecision());
  }

  state.runde++;
  viewThink(() => viewNegotiate());
}

/* ============================================================
   LETZTE RUNDE
============================================================ */

function viewDecision() {
  app.innerHTML = `
    <h1>Letzte Runde</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Letztes Angebot:</strong> ${eur(state.current_offer)}</strong>
    </div>

    <button id="takeBtn">Annehmen</button>
    <button id="noBtn" class="ghost">Ablehnen</button>

    ${historyTable()}
  `;

  document.getElementById("takeBtn").onclick = () =>
    finish(true, state.current_offer);
  document.getElementById("noBtn").onclick = () => finish(false, null);
}

/* ============================================================
   FINISH
============================================================ */

function finish(accepted, dealPrice) {
  state.accepted = !!accepted;
  state.finished = true;
  state.deal_price = dealPrice == null ? null : roundEuro(dealPrice);

  logRound({
    runde: state.runde,
    algo_offer: state.current_offer,
    proband_counter: dealPrice == null ? "" : state.deal_price,
    accepted: state.accepted,
    finished: true,
    deal_price: dealPrice == null ? "" : state.deal_price,
  });

  viewThink(() => viewFinish(state.accepted));
}

function viewFinish(accepted) {
  const dealPrice = state.deal_price ?? state.current_offer;

  let text;
  if (accepted) {
    text = `Einigung in Runde ${state.runde} bei ${eur(dealPrice)}.`;
  } else {
    text = `Keine Einigung.`;
  }

  app.innerHTML = `
    <h1>Verhandlung abgeschlossen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Ergebnis:</strong> ${text}</strong>
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

  document.getElementById("restartBtn").onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById("surveyBtn");
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        "https://docs.google.com/forms/d/e/1FAIpQLSddfk3DSXkwip_fTDijypc-QqpLYOfOlN45s4QouumBLyLLLA/viewform?usp=publish-editor";
    };
  }
}

/* ============================================================
   INIT
============================================================ */

viewVignette();
