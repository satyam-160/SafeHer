/* ============================================================================
   SafeHer — Women Safety SOS Keychain · Interactive Web Simulation
   ----------------------------------------------------------------------------
   Pure HTML + CSS + vanilla JS. No backend, no build step, no API keys.
   Open index.html directly in a browser.

   This is a SIMULATION. It never sends a real SMS, never places a real call
   and never contacts any real emergency service. All names, phone numbers
   and locations used here are fictional demo data.

   MODULE MAP
     CONFIG ............ every tunable timing / threshold in one place
     helpers ........... $ $$ sleep rand clamp fmt
     log ............... timestamped event log
     audio ............. Web Audio API siren (800 Hz / 1500 Hz alternation)
     mapView ........... Leaflet map, marker, pulse, simulated movement
     phone ............. trusted-contact list, SMS bubbles, call screen
     device ............ OLED text, status LEDs, SOS press-and-hold + ring
     stateMachine ...... IDLE / ARMING / ALARM_ACTIVE / GETTING_LOCATION /
                        SENDING_SMS / CALLING / ACTIVE_ALERT
     controls .......... network, GPS, battery, mute, reset
     demo .............. 40-second auto-run showcase with captions
   ========================================================================== */


/* ============================================================================
   1) CONFIG — all timings & thresholds live here
   ========================================================================== */
const CONFIG = {
  /* press-and-hold */
  HOLD_TRIGGER_MS: 3000,        // hold this long to fire SOS
  HOLD_CANCEL_MS: 5000,         // hold this long during an alert to cancel
  RING_RADIUS: 52,              // SVG progress-ring radius (must match CSS)

  /* GPS acquisition fake latency, per GPS-signal setting */
  GPS_DELAY: { good: 900, weak: 2100, none: 3000 },
  GPS_SATELLITES: { good: 12, weak: 5, none: 0 },
  GPS_LABEL: { good: 'OK', weak: 'WEAK', none: 'NO FIX' },
  GPS_NOTE: {
    good: 'GPS: 12 satellites locked — high accuracy fix',
    weak: 'GPS: 5 satellites — degraded accuracy, expect ~40m error',
    none: 'GPS: no fix — device falls back to LAST KNOWN LOCATION'
  },

  /* SMS dispatch */
  SMS_STAGGER_MS: 1100,         // delay between sending to each contact
  SMS_RETRY_MS: 900,            // delay between retries
  SMS_MAX_RETRY: 3,             // retries shown as "Retrying (n/3)..."
  SMS_NET_BEHAVIOUR: {          // demo-scripted outcome per network mode
    '4g':  { retries: 0, success: true },
    '2g':  { retries: 1, success: true },
    'none': { retries: 3, success: false }   // after 3 retries the SMS fails
  },

  /* auto-dial */
  CALL_RING_MS: 5000,           // each contact rings this long before moving on
  CALL_TICK_MS: 1000,

  /* siren (Web Audio) */
  SIREN_TONE_A: 800,            // Hz
  SIREN_TONE_B: 1500,           // Hz
  SIREN_SWAP_MS: 320,

  /* battery */
  BAT_MIN_V: 3.30,
  BAT_MAX_V: 4.10,
  BAT_LOW_PCT: 15,
  BAT_DRAIN_MS: 2000,           // tick while the siren is running
  BAT_DRAIN_PCT: 1,

  /* simulated movement */
  MOVE_INTERVAL_MS: 1100,
  MOVE_TILES: 5,

  /* demo contact data (fictional, masked) */
  CONTACTS: [
    { name: 'Priya Sharma', number: '+91 98XXX 00121' },
    { name: 'Rohan Verma',  number: '+91 97XXX 44208' },
    { name: 'Anjali Nair',  number: '+91 96XXX 77345' }
  ],

  /* auto-run demo — which contact picks up (0-based index) */
  DEMO_ANSWER_INDEX: 1,
  DEMO_TICK: 100,

  /* default map centre: Connaught Place, New Delhi */
  DEFAULT_LAT: 28.6139,
  DEFAULT_LON: 77.2090,
  DEFAULT_ZOOM: 16
};


/* ============================================================================
   2) HELPERS
   ========================================================================== */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Promise-based delay — never blocks the UI thread. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const pad2  = (n) => String(n).padStart(2, '0');

/** Current wall-clock time as HH:MM:SS. */
function nowClock() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Map a 0–100 battery percentage onto a realistic 3.30–4.10 V cell voltage. */
function batteryVoltage(pct) {
  const { BAT_MIN_V, BAT_MAX_V } = CONFIG;
  return BAT_MIN_V + (BAT_MAX_V - BAT_MIN_V) * (clamp(pct, 0, 100) / 100);
}

/** Google Maps deep link used inside the outgoing SMS body. */
function mapsLink(lat, lon) {
  return `https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
}


/* ============================================================================
   3) EVENT LOG
   ========================================================================== */
const log = {
  el: null,
  init() { this.el = $('#eventLog'); },

  /** Append one timestamped line. sev: 'info' | 'ok' | 'warn' | 'bad' | 'sos' */
  add(tag, msg, sev = 'info') {
    if (!this.el) return;
    const li = document.createElement('li');
    li.className = 'log-row';
    li.dataset.sev = sev;

    const t = document.createElement('span');
    t.className = 'log-time';
    t.textContent = nowClock();

    const g = document.createElement('span');
    g.className = 'log-tag';
    g.textContent = tag;

    const m = document.createElement('span');
    m.className = 'log-msg';
    m.textContent = msg;

    li.append(t, g, m);
    this.el.appendChild(li);
    this.el.scrollTop = this.el.scrollHeight;
  },

  clear() { if (this.el) this.el.innerHTML = ''; }
};


/* ============================================================================
   4) AUDIO — Web Audio API siren
   Browsers block audio until the user interacts with the page, hence the
   lazy AudioContext creation plus the explicit Mute toggle.
   ========================================================================== */
const audio = {
  ctx: null,
  osc: null,
  gain: null,
  swapTimer: null,
  high: false,
  muted: false,
  running: false,          // true while the siren is supposed to be sounding

  /** Create the audio graph on first use (needs a user gesture). */
  ensure() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { log.add('AUDIO', 'Web Audio API unavailable in this browser', 'warn'); return false; }

    this.ctx = new AC();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.ctx.destination);

    this.osc = this.ctx.createOscillator();
    this.osc.type = 'square';
    this.osc.frequency.value = CONFIG.SIREN_TONE_A;
    this.osc.connect(this.gain);
    this.osc.start();
    return true;
  },

  /** Resume a suspended context (browsers autoplay-block until a gesture). */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },

  /** Start the alternating two-tone siren. */
  start() {
    if (!this.ensure()) return;
    this.resume();
    this.running = true;
    this.high = false;
    this.osc.frequency.setValueAtTime(CONFIG.SIREN_TONE_A, this.ctx.currentTime);
    this.setVolume(this.muted ? 0 : 0.11);
    this.swapTimer = setInterval(() => this.swapTone(), CONFIG.SIREN_SWAP_MS);
    log.add('ALARM', `Siren ON — ${CONFIG.SIREN_TONE_A}/${CONFIG.SIREN_TONE_B} Hz alternating${this.muted ? ' (MUTED)' : ''}`, 'sos');
  },

  /** Alternate between the two siren frequencies. */
  swapTone() {
    if (!this.osc || !this.ctx) return;
    this.high = !this.high;
    this.osc.frequency.setValueAtTime(
      this.high ? CONFIG.SIREN_TONE_B : CONFIG.SIREN_TONE_A,
      this.ctx.currentTime
    );
  },

  /** Stop the siren and silence the oscillator. */
  stop() {
    if (this.swapTimer) { clearInterval(this.swapTimer); this.swapTimer = null; }
    this.running = false;
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      log.add('ALARM', 'Siren OFF', 'ok');
    }
  },

  setVolume(v) {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.04);
  },

  /** Turn the siren on (respecting the mute flag) or off. */
  setRunning(on) {
    this.running = on;
    if (on) { this.start(); } else { this.stop(); }
  }
};


/* ============================================================================
   5) APP STATE
   ========================================================================== */
const App = {
  state: 'IDLE',
  gps: 'good',                 // 'good' | 'weak' | 'none'
  net: '4g',                   // '4g' | '2g' | 'none'
  battery: 100,
  muted: false,
  moving: false,

  /* live simulated position */
  lat: CONFIG.DEFAULT_LAT,
  lon: CONFIG.DEFAULT_LON,
  lastKnown: { lat: CONFIG.DEFAULT_LAT, lon: CONFIG.DEFAULT_LON },
  fixAt: Date.now(),           // timestamp of the last position fix
  usingFallback: false,

  /* press-and-hold */
  holding: false,
  holdMode: null,              // 'trigger' | 'cancel'
  holdStart: 0,
  holdRaf: null,

  contacts: CONFIG.CONTACTS.map((c) => ({ ...c })),

  /* per-contact run status */
  smsState: ['idle', 'idle', 'idle'],
  callState: ['idle', 'idle', 'idle'],

  pendingCall: null,       // set while a contact's phone is ringing
  callConnected: false,    // true once a contact has picked up

  runToken: 0,             // bumped on every reset — aborts async runs
  autoDemo: false,

  /** Seconds since the last GPS position fix. */
  fixAgeSec() { return Math.max(0, Math.round((Date.now() - this.fixAt) / 1000)); }
};


/* ============================================================================
   6) DEVICE — OLED, LEDs, press-and-hold progress ring
   ========================================================================== */
const device = {
  el: {},
  init() {
    const e = this.el;
    e.btn        = $('#sosButton');
    e.keychain   = $('#keychain');
    e.ring       = $('#ringProgress');
    e.hint       = $('#holdHint');
    e.gps        = $('#oledGps');
    e.sim        = $('#oledSim');
    e.sos        = $('#oledSos');
    e.bat        = $('#oledBat');
    e.msg        = $('#oledMsg');
    e.ledPower   = $('#ledPower');
    e.ledNet     = $('#ledNet');
    e.ledAlert   = $('#ledAlert');
    e.specSim    = $('#specSim');
    e.specSats   = $('#specSats');
    e.specBattery= $('#specBattery');
    e.specContacts = $('#specContacts');

    this.circumference = 2 * Math.PI * CONFIG.RING_RADIUS;
    e.ring.style.strokeDasharray = this.circumference;
    e.ring.style.strokeDashoffset = this.circumference;

    this.bindHold();
    this.renderAll();
  },

  /* ---- press-and-hold: mouse, touch/pen, and keyboard (Space / Enter) ---- */
  bindHold() {
    const btn = this.el.btn;

    const down = (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      audio.ensure(); audio.resume();
      this.beginHold();
    };
    const up = () => this.endHold();

    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    window.addEventListener('pointerup', up);        // release outside the button
    btn.addEventListener('contextmenu', (ev) => ev.preventDefault()); // long-press menu

    btn.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter' || ev.code === 'Space') {
        ev.preventDefault();
        if (!ev.repeat) { audio.ensure(); audio.resume(); this.beginHold(); }
      }
    });
    btn.addEventListener('keyup', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter' || ev.code === 'Space') {
        ev.preventDefault();
        this.endHold();
      }
    });
    btn.addEventListener('blur', () => this.endHold());
  },

  /** Total hold duration required for the current mode. */
  requiredMs() {
    return App.holdMode === 'cancel' ? CONFIG.HOLD_CANCEL_MS : CONFIG.HOLD_TRIGGER_MS;
  },

  /** Start a press-and-hold. Mode depends on whether an alert is live. */
  beginHold() {
    if (App.holding) return;
    if (App.state === 'GETTING_LOCATION' || App.state === 'SENDING_SMS') {
      this.setMsg('BUSY — HOLD TO CANCEL', 'warn');
      return;
    }

    App.holding = true;
    App.holdStart = Date.now();
    /* an alert is live (ALARM_ACTIVE, CALLING, ACTIVE_ALERT, …) → this hold
       is the 5-second cancel gesture instead of a new trigger */
    App.holdMode = stateMachine.isAlerting() ? 'cancel' : 'trigger';

    this.el.btn.classList.add('is-holding');
    this.el.ring.classList.toggle('cancel-mode', App.holdMode === 'cancel');

    if (App.holdMode === 'cancel') {
      this.el.hint.textContent = `Keep holding ${CONFIG.HOLD_CANCEL_MS / 1000}s to send "I am safe"`;
      this.el.hint.classList.add('is-cancel');
      this.setMsg('CANCEL GESTURE...', 'warn');
      log.add('INPUT', 'Cancel gesture started — hold 5s', 'warn');
    } else {
      this.el.hint.textContent = 'Keep holding...';
      this.el.hint.classList.remove('is-cancel');
      this.setMsg('HOLD TO TRIGGER', 'info');
      log.add('INPUT', 'SOS button pressed — hold in progress', 'sos');
    }

    this.tick();
  },

  /** Release the button. */
  endHold() {
    if (!App.holding) return;
    App.holding = false;
    this.stopTick();

    this.el.btn.classList.remove('is-holding');
    this.el.ring.classList.remove('cancel-mode');
    this.setRing(0);
    this.el.hint.classList.remove('is-cancel');

    const held = Date.now() - App.holdStart;
    const need = this.requiredMs();
    const mode = App.holdMode;
    App.holdMode = null;

    if (held < need) {
      // released too early → cancel the gesture
      if (mode === 'trigger') {
        this.el.hint.textContent = 'Press & hold 3s to alert';
        this.setMsg('CANCELLED', 'warn');
        this.setSos('IDLE');
        log.add('INPUT', `Hold released early (${(held / 1000).toFixed(1)}s / ${need / 1000}s) — aborted`, 'warn');
      } else {
        this.el.hint.textContent = 'Press & hold 3s to alert';
        this.setMsg('CANCEL ABORTED', 'warn');
        log.add('INPUT', 'Cancel gesture released early — siren still active', 'warn');
      }
      return;
    }

    // full duration reached
    if (mode === 'trigger') stateMachine.triggerSOS();
    else stateMachine.cancelAlert();
  },

  /**
   * Drive the circular progress ring. Uses a timer rather than
   * requestAnimationFrame so the ring still animates when the tab is
   * throttled, the window is unfocused, or the demo runs in a headless
   * browser for a projector/screen recording.
   */
  tick() {
    const step = () => {
      if (!App.holding) { this.stopTick(); return; }
      const held = Date.now() - App.holdStart;
      const pct = clamp(held / this.requiredMs(), 0, 1);
      this.setRing(pct);
      if (pct >= 1) this.endHold();      // full duration reached
    };
    this.stopTick();
    App.holdRaf = setInterval(step, 30);
    step();
  },

  stopTick() {
    if (App.holdRaf) { clearInterval(App.holdRaf); App.holdRaf = null; }
  },

  setRing(pct) {
    this.el.ring.style.strokeDashoffset = this.circumference * (1 - pct);
  },

  /* ---------------- OLED + LED rendering ---------------- */
  setMsg(text, tone = 'info') {
    this.el.msg.textContent = text;
    this.el.msg.className = 'oled-msg' + (tone && tone !== 'info' ? ' ' + tone : '');
  },
  setGps(tone) { this.el.gps.textContent = CONFIG.GPS_LABEL[App.gps]; this.el.gps.className = 'oled-v ' + tone; },
  setSos(text, tone = '') { this.el.sos.textContent = text; this.el.sos.className = 'oled-v' + (tone ? ' ' + tone : ''); },
  setSim() {
    const nets = { '4g': '4G 0042', '2g': '2G 0042', 'none': 'NO NET' };
    const tones = { '4g': '', '2g': 'warn', 'none': 'error' };
    this.el.sim.textContent = nets[App.net];
    this.el.sim.className = 'oled-v ' + tones[App.net];
    this.el.specSim.innerHTML = App.net === 'none'
      ? 'Offline &middot; no SIM'
      : (App.net === '4g' ? 'LTE &middot; Airtel' : '2G &middot; Airtel');
  },
  setBattery() {
    const pct = App.battery;
    const v = batteryVoltage(pct).toFixed(2);
    this.el.bat.textContent = `${v}V ${pct}%`;
    this.el.bat.className = 'oled-v' + (pct < CONFIG.BAT_LOW_PCT ? ' warn' : '');
    this.el.specBattery.textContent = `${v}V · ${pct}%`;
  },
  setSats() {
    const n = CONFIG.GPS_SATELLITES[App.gps];
    this.el.specSats.textContent = n ? `${n} locked` : 'no fix · LKL';
  },

  setLed(name, on, blink = false) {
    const map = { power: this.el.ledPower, net: this.el.ledNet, alert: this.el.ledAlert };
    const el = map[name];
    if (!el) return;
    el.classList.toggle('is-on', !!on);
    el.classList.toggle('blink', !!blink);
  },

  /** Full redraw of the OLED + spec strip. */
  renderAll() {
    this.setGps(App.gps === 'good' ? '' : (App.gps === 'weak' ? 'warn' : 'error'));
    this.setSim();
    this.setBattery();
    this.setSats();
    this.setLed('power', true);
    this.setLed('net', App.net !== 'none');
    this.el.specContacts.textContent = `${App.contacts.length} trusted`;
  },

  /** Visual alarm state: red LED blink + body shake. */
  setAlarmVisual(on) {
    this.el.keychain.classList.toggle('is-alerting', on);
    this.setLed('alert', on, on);
  }
};


/* ============================================================================
   7) MAP — Leaflet + marker + simulated movement
   ========================================================================== */
const mapView = {
  map: null,
  marker: null,
  route: null,
  tile: null,
  moveTimer: null,
  step: 0,

  /* short walking route (lat/lon offsets) used by "Simulate movement" */
  ROUTE: [
    [0, 0], [0.00032, 0.00026], [0.00061, 0.00055],
    [0.00088, 0.00084], [0.00112, 0.00112], [0.00131, 0.00143]
  ],

  init() {
    this.map = L.map('map', { zoomControl: true, attributionControl: true })
                .setView([App.lat, App.lon], CONFIG.DEFAULT_ZOOM);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(this.map);

    /* custom pulsing marker */
    const icon = L.divIcon({
      className: '',
      html: '<div class="victim-marker"><div class="victim-pulse"></div><div class="victim-pin"></div></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 22]
    });

    this.marker = L.marker([App.lat, App.lon], { icon, zIndexOffset: 1000 }).addTo(this.map);

    /* faint line showing the walkable route */
    this.route = L.polyline(
      this.ROUTE.map(([dx, dy]) => [App.lastKnown.lat + dy, App.lastKnown.lon + dx]),
      { color: '#ec4899', weight: 2, opacity: 0.35, dashArray: '4 6' }
    ).addTo(this.map);

    this.updateBadge();
  },

  /** Refresh the "LIVE · Ns ago" badge above the map. */
  updateBadge() {
    const badge = $('#mapBadge');
    const age = App.fixAgeSec();
    if (App.usingFallback) {
      badge.textContent = `LAST KNOWN · ${age}s ago`;
      badge.classList.add('is-fallback');
    } else {
      badge.textContent = `LIVE · ${age}s ago`;
      badge.classList.remove('is-fallback');
    }
  },

  /** Move the marker to an absolute position and mark a fresh fix. */
  setPosition(lat, lon, { isFix = true } = {}) {
    App.lat = lat;
    App.lon = lon;
    this.marker.setLatLng([lat, lon]);
    if (isFix) {
      App.fixAt = Date.now();
      App.lastKnown = { lat, lon };
      App.usingFallback = false;
    }
    this.updateBadge();
  },

  /** Start / stop the slow movement along the route. */
  setMovement(on) {
    const wasRunning = !!this.moveTimer;
    if (this.moveTimer) { clearInterval(this.moveTimer); this.moveTimer = null; }
    App.moving = on;

    if (on) {
      this.step = 0;
      this.route.setLatLngs(
        this.ROUTE.map(([dx, dy]) => [App.lastKnown.lat + dy, App.lastKnown.lon + dx])
      );
      this.moveTimer = setInterval(() => {
        this.step = (this.step + 1) % (CONFIG.MOVE_TILES + 1);
        const [dx, dy] = this.ROUTE[this.step];
        this.setPosition(App.lastKnown.lat + dy, App.lastKnown.lon + dx, { isFix: App.gps !== 'none' });
        if (this.step === 0) {          // looped back to the start of the route
          this.route.setLatLngs(
            this.ROUTE.map(([ox, oy]) => [App.lastKnown.lat + oy, App.lastKnown.lon + ox])
          );
        }
      }, CONFIG.MOVE_INTERVAL_MS);
      log.add('MAP', 'Simulated movement enabled — live location streaming', 'ok');
    } else if (wasRunning) {
      log.add('MAP', 'Simulated movement stopped', 'info');
    }
  },

  /** Re-centre the map on a manually entered lat,lon pair. */
  applyManual(lat, lon) {
    this.setPosition(lat, lon, { isFix: true });
    this.route.setLatLngs(this.ROUTE.map(([dx, dy]) => [lat + dy, lon + dx]));
    this.map.setView([lat, lon], CONFIG.DEFAULT_ZOOM);
  }
};


/* ============================================================================
   8) PHONE — trusted contacts, SMS bubbles, incoming-call screen
   ========================================================================== */
const phone = {
  el: {},
  callTickTimer: null,
  clockTimer: null,
  callSeconds: 0,

  init() {
    const e = this.el;
    e.list   = $('#contactList');
    e.thread = $('#smsThread');
    e.empty  = $('#smsEmpty');
    e.callView = $('#callView');
    e.callName = $('#callName');
    e.callSub  = $('#callSub');
    e.callTimer = $('#callTimer');
    e.accept = $('#callAccept');
    e.decline = $('#callDecline');
    e.time = $('#phoneTime');
    e.signal = $('#phoneSignal');

    this.callTickTimer = null;
    this.callSeconds = 0;

    /* one handler each; the meaning depends on whether the call is ringing
       or already connected (Accept/Mute, Decline/End) */
    e.accept.addEventListener('click', () => {
      stateMachine.resolveCall(App.callConnected ? 'muted' : 'answered');
    });
    e.decline.addEventListener('click', () => {
      stateMachine.resolveCall(App.callConnected ? 'ended' : 'declined');
    });

    this.renderContacts();
    this.clockTimer = setInterval(() => { e.time.textContent = nowClock().slice(0, 5); }, 1000);
  },

  /* -------- contacts list with editable names (fictional numbers) -------- */
  renderContacts() {
    this.el.list.innerHTML = '';
    App.contacts.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'contact-item';
      li.dataset.index = i;

      const nameWrap = document.createElement('div');
      nameWrap.className = 'contact-name';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = c.name;
      input.setAttribute('aria-label', `Trusted contact ${i + 1} name`);
      input.addEventListener('input', () => { c.name = input.value; });

      const num = document.createElement('span');
      num.className = 'contact-num';
      num.textContent = c.number;

      nameWrap.append(input, num);

      const smsChip = document.createElement('span');
      smsChip.className = 'chip';
      smsChip.dataset.role = 'sms';
      smsChip.textContent = 'idle';

      const callChip = document.createElement('span');
      callChip.className = 'chip';
      callChip.dataset.role = 'call';
      callChip.textContent = 'idle';

      li.append(nameWrap, smsChip, callChip);
      this.el.list.appendChild(li);
    });
  },

  /** Update one contact's status chips. */
  setChip(index, role, text, tone) {
    const item = this.el.list.querySelector(`.contact-item[data-index="${index}"]`);
    if (!item) return;
    const chip = item.querySelector(`.chip[data-role="${role}"]`);
    if (!chip) return;
    chip.textContent = text;
    chip.className = 'chip' + (tone ? ' ' + tone : '');
  },

  resetChips() {
    App.contacts.forEach((_, i) => {
      this.setChip(i, 'sms', 'idle', '');
      this.setChip(i, 'call', 'idle', '');
      const item = this.el.list.querySelector(`.contact-item[data-index="${i}"]`);
      if (item) item.classList.remove('is-calling', 'is-answered');
    });
  },

  /* ---------------- SMS bubble rendering ---------------- */
  clearThread() {
    this.el.thread.innerHTML = '';
    this.el.empty.hidden = false;
  },

  /**
   * Append a bubble to the thread.
   * kind: 'out' (device→contact) | 'in' (contact reply) | 'system' | 'fallback'
   */
  addSms(kind, html, meta) {
    this.el.empty.hidden = true;
    const div = document.createElement('div');
    div.className = `sms-bubble ${kind}`;
    div.innerHTML = html;
    if (meta) {
      const m = document.createElement('span');
      m.className = 'sms-meta';
      m.textContent = meta;
      div.appendChild(m);
    }
    this.el.thread.appendChild(div);
    this.el.thread.parentElement.scrollTop = this.el.thread.parentElement.scrollHeight;
  },

  /* ---------------- incoming call screen ---------------- */
  showCall(name, seconds = 0) {
    App.callConnected = false;
    this.el.callName.textContent = name;
    this.el.callSub.textContent = 'incoming call from SafeHer device';
    this.el.callTimer.textContent = this.fmtDur(seconds);
    this.el.callView.hidden = false;
    this.el.accept.classList.add('wobble');
    this.el.decline.classList.add('wobble');
    this.el.signal.textContent = 'SafeHer · calling';

    this.callSeconds = seconds;
    if (this.callTickTimer) clearInterval(this.callTickTimer);
    this.callTickTimer = setInterval(() => {
      this.callSeconds += 1;
      this.el.callTimer.textContent = this.fmtDur(this.callSeconds);
    }, CONFIG.CALL_TICK_MS);
  },

  /** Mark the current call as connected and stop the ringing wobble. */
  markAnswered(name) {
    App.callConnected = true;
    this.el.callName.textContent = name;
    this.el.callSub.textContent = 'connected — two-way audio open';
    this.el.accept.classList.remove('wobble');
    this.el.decline.classList.remove('wobble');
    this.el.accept.textContent = 'Mute';
    this.el.decline.textContent = 'End';
    this.el.signal.textContent = 'SafeHer · on call';
  },

  hideCall() {
    App.callConnected = false;
    this.el.callView.hidden = true;
    this.el.signal.textContent = 'SafeHer · trusted';
    this.el.callTimer.textContent = '00:00';
    this.el.accept.textContent = 'Accept';
    this.el.decline.textContent = 'Decline';
    this.el.accept.classList.remove('wobble');
    this.el.decline.classList.remove('wobble');
    if (this.callTickTimer) { clearInterval(this.callTickTimer); this.callTickTimer = null; }
    this.callSeconds = 0;
  },

  fmtDur(s) {
    return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
  }
};


/* ============================================================================
   9) STATE MACHINE
   IDLE → ARMING → ALARM_ACTIVE → GETTING_LOCATION → SENDING_SMS
        → CALLING → ACTIVE_ALERT → IDLE
   ========================================================================== */
const stateMachine = {
  ORDER: ['IDLE', 'ARMING', 'ALARM_ACTIVE', 'GETTING_LOCATION', 'SENDING_SMS', 'CALLING', 'ACTIVE_ALERT'],
  activeTimer: null,   // keeps the "updated Ns ago" badge ticking while live
  drainTimer: null,    // battery drain while the siren runs

  /** True while the device is latched into any alert phase. */
  isAlerting() {
    return ['ALARM_ACTIVE', 'GETTING_LOCATION', 'SENDING_SMS', 'CALLING', 'ACTIVE_ALERT'].includes(App.state);
  },

  /** Move to a new state and repaint the debug strip. */
  set(state) {
    App.state = state;

    const idx = this.ORDER.indexOf(state);
    $$('.state-node').forEach((node) => {
      const i = this.ORDER.indexOf(node.dataset.state);
      node.classList.toggle('is-active', i === idx);
      node.classList.toggle('is-done', i < idx);
    });
    $('#stateValue').textContent = state;

    const sosText = {
      IDLE: ['IDLE', ''],
      ARMING: ['ARMING', 'warn'],
      ALARM_ACTIVE: ['ALERT', 'alert'],
      GETTING_LOCATION: ['LOCATING', 'warn'],
      SENDING_SMS: ['SMS x3', 'warn'],
      CALLING: ['DIALING', 'alert'],
      ACTIVE_ALERT: ['ALERT', 'alert']
    }[state] || ['IDLE', ''];
    device.setSos(sosText[0], sosText[1]);
  },

  /* ---------------- entry point: 3 s hold completed ---------------- */
  async triggerSOS() {
    if (this.isAlerting()) return;
    const token = App.runToken;

    log.add('SOS', 'HOLD COMPLETE — SOS latched', 'sos');
    device.el.hint.textContent = 'Hold 5s to send "I am safe"';
    device.el.hint.classList.add('is-cancel');
    device.setRing(0);

    /* siren + visual alarm start immediately (muting only silences the gain) */
    this.set('ALARM_ACTIVE');
    device.setAlarmVisual(true);
    audio.setRunning(true);
    device.setMsg('ALARM ACTIVE', 'alert');
    this.startBatteryDrain();

    await sleep(350);
    if (token !== App.runToken) return;
    await this.getLocation(token);
  },

  /* ---------------- step 1: acquire GPS (with last-known fallback) ------- */
  async getLocation(token) {
    this.set('GETTING_LOCATION');
    device.setGps(App.gps === 'good' ? '' : (App.gps === 'weak' ? 'warn' : 'error'));
    device.setMsg('ACQUIRING GPS...', 'warn');
    log.add('GPS', `Acquiring fix (signal: ${App.gps.toUpperCase()})`, 'warn');

    const delay = CONFIG.GPS_DELAY[App.gps];
    await sleep(delay);
    if (token !== App.runToken) return;

    if (App.gps === 'none') {
      /* no satellites → reuse the stored last known position */
      App.usingFallback = true;
      App.lat = App.lastKnown.lat;
      App.lon = App.lastKnown.lon;
      mapView.setPosition(App.lat, App.lon, { isFix: false });
      mapView.updateBadge();
      log.add('GPS', `No satellites — falling back to LAST KNOWN location (${App.fixAgeSec()}s old)`, 'bad');
      device.setMsg('NO FIX — USING LAST KNOWN', 'error');
    } else {
      /* simulate a fresh fix at the current position */
      const jitter = App.gps === 'weak' ? 0.00035 : 0.00004;
      const jitterAlt = App.gps === 'weak' ? 0.00030 : 0.00003;
      const nl = App.lat + (Math.random() - 0.5) * jitter;
      const no = App.lon + (Math.random() - 0.5) * jitterAlt;
      App.usingFallback = false;
      mapView.setPosition(nl, no, { isFix: true });
      log.add('GPS', `Fix acquired — ${CONFIG.GPS_SATELLITES[App.gps]} satellites, ±${App.gps === 'weak' ? 40 : 5}m`, 'ok');
      device.setMsg(`GPS ${App.gps === 'weak' ? 'WEAK' : 'LOCKED'}`, App.gps === 'weak' ? 'warn' : '');
    }
    mapView.updateBadge();

    await sleep(420);
    if (token !== App.runToken) return;
    await this.sendSms(token);
  },

  /* ---------------- step 2: SMS to every trusted contact ------------------ */
  async sendSms(token) {
    this.set('SENDING_SMS');
    device.setMsg('SENDING SMS...', 'warn');

    const behaviour = CONFIG.SMS_NET_BEHAVIOUR[App.net];
    const link = mapsLink(App.lat, App.lon);

    for (let i = 0; i < App.contacts.length; i++) {
      if (token !== App.runToken) return;
      const c = App.contacts[i];

      if (App.net === 'none') {
        /* ---- offline: show the retry ladder, then fail on purpose ---- */
        phone.setChip(i, 'sms', 'queued', 'wait');
        for (let attempt = 1; attempt <= CONFIG.SMS_MAX_RETRY; attempt++) {
          if (token !== App.runToken) return;
          phone.addSms('fallback', `No network. <b>Retrying (${attempt}/${CONFIG.SMS_MAX_RETRY})</b>&hellip; SMS queued in flash.`);
          phone.setChip(i, 'sms', `retry ${attempt}/${CONFIG.SMS_MAX_RETRY}`, 'bad');
          log.add('SMS', `No carrier — retry ${attempt}/${CONFIG.SMS_MAX_RETRY} for ${c.name}`, 'bad');
          device.setMsg(`RETRY ${attempt}/${CONFIG.SMS_MAX_RETRY}`, 'error');
          await sleep(CONFIG.SMS_RETRY_MS);
          if (token !== App.runToken) return;
        }
        if (!behaviour.success) {
          phone.setChip(i, 'sms', 'FAILED', 'bad');
          log.add('SMS', `FAILED for ${c.name} — all ${CONFIG.SMS_MAX_RETRY} retries exhausted`, 'bad');
          phone.addSms('in', 'SafeHer: <b>Message not delivered.</b> Try calling the device number directly.');
          continue;
        }
      } else if (behaviour.retries > 0) {
        /* ---- 2G: one retry, then it goes through ---- */
        phone.setChip(i, 'sms', 'retry 1/1', 'wait');
        log.add('SMS', `Weak 2G link — retrying once for ${c.name}`, 'warn');
        device.setMsg('2G RETRY 1/1', 'warn');
        await sleep(CONFIG.SMS_RETRY_MS);
        if (token !== App.runToken) return;
      }

      /* ---- build the emergency SMS body ---- */
      const satTxt = App.usingFallback
        ? `${CONFIG.GPS_SATELLITES.none} — LAST KNOWN LOCATION, updated ${App.fixAgeSec()}s ago`
        : `${CONFIG.GPS_SATELLITES[App.gps]}`;
      const body =
        `EMERGENCY! I need help. My location: ` +
        `<a href="${link}" target="_blank" rel="noopener">${link}</a> ` +
        `(Satellites: ${satTxt}). Battery: ${App.battery}%.`;

      phone.addSms('out', body, `Delivered · ${nowClock().slice(0, 5)}`);
      phone.setChip(i, 'sms', 'Delivered', 'ok');
      log.add('SMS', `Alert SMS sent → ${c.name} (${c.number})`, 'ok');

      if (i < App.contacts.length - 1) {
        device.setMsg(`SMS ${i + 1}/${App.contacts.length} SENT`, 'warn');
        await sleep(CONFIG.SMS_STAGGER_MS);
      }
    }

    if (token !== App.runToken) return;
    await this.callContacts(token);
  },

  /* ---------------- step 3: auto-dial contacts in order ------------------- */
  async callContacts(token) {
    this.set('CALLING');
    device.setMsg('AUTO-DIALING...', 'alert');

    for (let i = 0; i < App.contacts.length; i++) {
      if (token !== App.runToken) return;
      const c = App.contacts[i];

      const item = phone.el.list.querySelector(`.contact-item[data-index="${i}"]`);
      if (item) item.classList.add('is-calling');
      phone.setChip(i, 'call', 'Ringing', 'live');
      App.callState[i] = 'ringing';
      log.add('CALL', `Auto-dialing ${c.name} (${c.number}) — SIM slot 1`, 'sos');
      phone.showCall(`SafeHer SOS`, 0);

      const outcome = await this.ringContact(i, token);
      App.callState[i] = outcome;
      if (token !== App.runToken) return;      // cancelled / reset mid-ring
      if (outcome === 'answered') {
        phone.setChip(i, 'call', 'Answered', 'ok');
        if (item) { item.classList.remove('is-calling'); item.classList.add('is-answered'); }
        log.add('CALL', `${c.name} ANSWERED — live voice channel open`, 'ok');
        phone.addSms('in', `SafeHer: <b>${c.name}</b> is on the line. Stay on call, help is being coordinated.`);
        break;
      }

      /* no answer / declined → next contact */
      phone.setChip(i, 'call', outcome === 'declined' ? 'Declined' : 'No answer', 'bad');
      if (item) item.classList.remove('is-calling');
      log.add('CALL', `${c.name} ${outcome === 'declined' ? 'declined' : 'did not answer'} → next contact`, 'warn');
      phone.addSms('system', `${c.name} did not answer — trying next trusted contact`);
      if (i < App.contacts.length - 1) await sleep(600);
      if (token !== App.runToken) return;
    }

    if (token !== App.runToken) return;
    phone.hideCall();
    await this.activeAlert(token);
  },

  /**
   * Wait for one contact to pick up (or time out).
   * App.pendingCall(result) is the external hook used by the call screen.
   * Resolves 'answered' | 'declined' | 'noanswer' | 'cancelled'.
   */
  ringContact(index, token) {
    return new Promise((resolve) => {
      const c = App.contacts[index];
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        App.pendingCall = null;
        if (result === 'answered') phone.markAnswered(c.name);
        resolve(result);
      };

      const timer = setTimeout(() => finish('noanswer'), CONFIG.CALL_RING_MS);
      App.pendingCall = finish;

      /* during the auto-run demo, one contact picks up automatically */
      if (App.autoDemo && index === CONFIG.DEMO_ANSWER_INDEX) {
        setTimeout(() => {
          if (token === App.runToken) finish('answered');
        }, 1100);
      }
    });
  },

  /** Buttons on the call screen. */
  resolveCall(kind) {
    /* still ringing: Accept / Decline */
    if (App.pendingCall) {
      if (kind === 'answered') {
        App.callConnected = true;
        App.pendingCall('answered');
      } else {
        App.callConnected = false;
        App.pendingCall('declined');
      }
      return;
    }
    /* already connected: Mute / End */
    if (App.callConnected) {
      if (kind === 'muted') {
        const muteCall = !App.muted;
        $('#muteToggle').checked = muteCall;
        $('#muteToggle').dispatchEvent(new Event('change'));
        return;
      }
      App.callConnected = false;
      this.cancelAlert('call-ended');
    }
  },

  /* ---------------- step 4: steady alert until cancelled ----------------- */
  async activeAlert(token) {
    this.set('ACTIVE_ALERT');
    device.setMsg('ALERT LIVE — HOLD 5s TO CANCEL', 'alert');
    device.el.hint.textContent = 'Hold 5s to send "I am safe"';
    device.el.hint.classList.add('is-cancel');
    log.add('SOS', 'All contacts notified. Siren continues until cancelled.', 'sos');

    /* keep the "updated Ns ago" badge honest while the alert is live */
    this.activeTimer = setInterval(() => mapView.updateBadge(), 1000);
  },

  /* ---------------- cancel / false-alarm path ---------------- */
  cancelAlert(reason) {
    if (!this.isAlerting()) return;

    /* The alert is over, so abort the whole alert pipeline: every in-flight
       async step (GPS, SMS stagger, ringing) bails on its next token check.
       This is what stops a late showCall() from resurrecting the call screen. */
    App.runToken++;
    const token = App.runToken;

    /* settle a ringing call so its promise never dangles */
    if (App.pendingCall) {
      const settle = App.pendingCall;
      App.pendingCall = null;
      settle('cancelled');
    }
    App.callConnected = false;

    log.add('SOS', 'Cancel gesture complete — sending "I am safe"', 'ok');
    audio.setRunning(false);
    device.setAlarmVisual(false);
    this.stopBatteryDrain();
    if (this.activeTimer) { clearInterval(this.activeTimer); this.activeTimer = null; }

    /* safety SMS to all contacts */
    for (let i = 0; i < App.contacts.length; i++) {
      phone.setChip(i, 'sms', 'Sending', 'wait');
      if (App.callState[i] === 'ringing') phone.setChip(i, 'call', 'Ended', 'bad');
    }
    phone.addSms('system', 'All contacts: <b>False alarm — I am safe.</b> Sorry for the scare. The siren has been stopped.');
    setTimeout(() => {
      if (token !== App.runToken) return;
      App.contacts.forEach((c, i) => {
        phone.setChip(i, 'sms', 'Delivered', 'ok');
        log.add('SMS', `"I am safe" SMS delivered → ${c.name}`, 'ok');
      });
    }, 900);

    phone.hideCall();
    device.setMsg('CANCELLED — ALL SAFE', 'ok');
    device.el.hint.textContent = 'Press & hold 3s to alert';
    device.el.hint.classList.remove('is-cancel');

    log.add('SOS', reason === 'call-ended'
      ? 'Call ended by contact — siren stopped'
      : 'Siren stopped. All contacts notified that the user is safe.', 'ok');

    this.set('IDLE');
  },

  /* ---------------- battery drain while alarming ---------------- */
  startBatteryDrain() {
    this.stopBatteryDrain();
    this.drainTimer = setInterval(() => {
      if (App.battery <= 0) return;
      App.battery = clamp(App.battery - CONFIG.BAT_DRAIN_PCT, 0, 100);
      device.setBattery();
      controls.syncBattery();
      if (App.battery === CONFIG.BAT_LOW_PCT - 1) {
        log.add('BATT', `Battery low — ${App.battery}%`, 'warn');
        device.setMsg('LOW BATTERY', 'warn');
      }
    }, CONFIG.BAT_DRAIN_MS);
  },
  stopBatteryDrain() {
    if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; }
  }
};


/* ============================================================================
   10) CONTROLS
   ========================================================================== */
const controls = {
  init() {
    /* --- GPS signal segmented control --- */
    $$('.seg-btn[data-gps]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.seg-btn[data-gps]').forEach((b) => b.classList.remove('is-on'));
        btn.classList.add('is-on');
        App.gps = btn.dataset.gps;

        device.renderAll();
        mapView.updateBadge();
        const note = $('#gpsNote');
        note.textContent = CONFIG.GPS_NOTE[App.gps];
        note.classList.toggle('is-warn', App.gps !== 'good');
        log.add('GPS', `Signal set to ${App.gps.toUpperCase()}${App.gps === 'none' ? ' — last known location will be used' : ''}`,
          App.gps === 'good' ? 'ok' : 'warn');
      });
    });

    /* --- network segmented control --- */
    $$('.seg-btn[data-net]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.seg-btn[data-net]').forEach((b) => b.classList.remove('is-on'));
        btn.classList.add('is-on');
        App.net = btn.dataset.net;
        device.setSim();
        device.setLed('net', App.net !== 'none');
        log.add('NET', `Network set to ${App.net === 'none' ? 'NO NETWORK' : App.net.toUpperCase()}`,
          App.net === 'none' ? 'bad' : 'ok');
      });
    });

    /* --- movement toggle --- */
    $('#movementToggle').addEventListener('change', (ev) => {
      mapView.setMovement(ev.target.checked);
    });

    /* --- manual start location --- */
    $('#applyLoc').addEventListener('click', () => {
      const raw = $('#startLoc').value.trim();
      const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (!m) {
        log.add('MAP', `Invalid location "${raw}" — use format "lat, lon"`, 'bad');
        device.setMsg('BAD LOCATION', 'error');
        return;
      }
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        log.add('MAP', 'Coordinates out of range', 'bad');
        device.setMsg('OUT OF RANGE', 'error');
        return;
      }
      mapView.applyManual(lat, lon);
      App.lastKnown = { lat, lon };
      log.add('MAP', `Start location set to ${lat.toFixed(5)}, ${lon.toFixed(5)}`, 'ok');
    });

    $('#startLoc').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); $('#applyLoc').click(); }
    });

    /* --- battery slider --- */
    $('#battery').addEventListener('input', (ev) => {
      App.battery = parseInt(ev.target.value, 10);
      device.setBattery();
      this.syncBattery();
    });
    this.syncBattery();

    /* --- mute toggle --- */
    $('#muteToggle').addEventListener('change', (ev) => {
      App.muted = ev.target.checked;
      audio.muted = App.muted;
      audio.ensure();
      if (App.muted) {
        audio.setVolume(0);
        log.add('ALARM', 'Siren muted', 'warn');
      } else {
        audio.setVolume(audio.running ? 0.11 : 0);
        log.add('ALARM', 'Siren unmuted', 'ok');
      }
      device.setMsg(App.muted ? 'ALARM MUTED' : 'ALARM ON', App.muted ? 'warn' : '');
    });

    /* --- auto-run demo --- */
    $('#autoRunBtn').addEventListener('click', () => {
      if (App.autoDemo) demo.stop();
      else demo.start();
    });

    /* --- reset --- */
    $('#resetBtn').addEventListener('click', () => this.reset());

    /* --- clear log --- */
    $('#clearLog').addEventListener('click', () => log.clear());
  },

  /** Keep the slider, label and warning state in sync with App.battery. */
  syncBattery() {
    const slider = $('#battery');
    const label = $('#batteryVal');
    const note = $('#batteryNote');
    slider.value = App.battery;
    label.textContent = `${App.battery}%`;

    const low = App.battery < CONFIG.BAT_LOW_PCT;
    slider.classList.toggle('is-low', low);
    if (App.battery === 0) note.textContent = 'Flat — device will power off';
    else if (low) note.textContent = `LOW BATTERY (<${CONFIG.BAT_LOW_PCT}%) — reduce alert duration`;
    else if (App.battery < 45) note.textContent = 'Moderate charge';
    else note.textContent = 'Full charge';
    note.classList.toggle('is-cancel', low);
  },

  /** Return the whole simulation to its initial state. */
  reset() {
    App.runToken++;                     // aborts any in-flight async run
    demo.stop(true);
    stateMachine.stopBatteryDrain();
    if (stateMachine.activeTimer) { clearInterval(stateMachine.activeTimer); stateMachine.activeTimer = null; }

    audio.setRunning(false);
    device.setAlarmVisual(false);

    App.holding = false;
    device.stopTick();
    device.el.btn.classList.remove('is-holding');
    device.setRing(0);

    App.battery = 100;
    App.gps = 'good';
    App.net = '4g';
    App.usingFallback = false;
    App.pendingCall = null;
    App.callConnected = false;
    App.lat = App.lastKnown.lat;
    App.lon = App.lastKnown.lon;

    /* reset segmented controls */
    $$('.seg-btn').forEach((b) => b.classList.toggle('is-on',
      (b.dataset.gps && b.dataset.gps === 'good') || (b.dataset.net && b.dataset.net === '4g')));
    $('#movementToggle').checked = false;
    if (App.moving) mapView.setMovement(false);
    $('#muteToggle').checked = false;
    App.muted = false;
    audio.muted = false;

    /* reset map */
    mapView.setPosition(CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON, { isFix: true });
    mapView.applyManual(CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON);
    $('#startLoc').value = `${CONFIG.DEFAULT_LAT}, ${CONFIG.DEFAULT_LON}`;
    $('#gpsNote').textContent = CONFIG.GPS_NOTE.good;
    $('#gpsNote').classList.remove('is-warn');

    /* reset phone */
    phone.resetChips();
    phone.clearThread();
    phone.hideCall();

    /* reset device display */
    device.el.hint.textContent = 'Press & hold 3s to alert';
    device.el.hint.classList.remove('is-cancel');
    device.setMsg('READY', 'info');
    device.setAlarmVisual(false);
    device.renderAll();
    this.syncBattery();

    stateMachine.set('IDLE');
    log.add('SYSTEM', 'Simulation reset — device idle', 'ok');
  }
};


/* ============================================================================
   11) AUTO-RUN DEMO — the ~40 s judge-facing showcase
   ========================================================================== */
const demo = {
  running: false,
  token: 0,

  /** Start or toggle the demo. */
  start() {
    if (this.running) { this.stop(); return; }

    /* always begin from a clean slate so the story reads clearly */
    controls.reset();
    this.running = true;
    App.autoDemo = true;
    const t = ++this.token;

    const btn = $('#autoRunBtn');
    btn.classList.add('is-running');
    $('#autoRunLabel').textContent = '■ Stop demo';
    $('#captionBar').hidden = false;

    log.add('DEMO', 'Auto-run showcase started', 'sos');
    this.play(t);
  },

  /** Stop the demo (silent = do not log). */
  stop(silent = false) {
    this.token++;
    this.running = false;
    App.autoDemo = false;
    const btn = $('#autoRunBtn');
    if (btn) {
      btn.classList.remove('is-running');
      $('#autoRunLabel').textContent = '▶ Auto-run demo';
    }
    const bar = $('#captionBar');
    if (bar) { bar.hidden = true; }
    if (!silent) log.add('DEMO', 'Auto-run demo stopped', 'warn');
  },

  /** Show a caption, then wait. Returns false if the demo was aborted. */
  async say(t, text, ms) {
    if (t !== this.token) return false;
    $('#captionText').textContent = text;
    await sleep(ms);
    return t === this.token;
  },

  /**
   * Hold the SOS button long enough to satisfy the real threshold, then
   * release. The progress ring completes the hold on its own at 100%, so the
   * explicit endHold() is only a safety net. Timings are derived from CONFIG
   * so the demo can never drift out of sync with the gesture it is showing.
   */
  async hold(t, caption, mode) {
    const need = (mode === 'cancel' ? CONFIG.HOLD_CANCEL_MS : CONFIG.HOLD_TRIGGER_MS) + 600;
    if (t !== this.token) return false;
    device.el.btn.focus({ preventScroll: true });
    device.beginHold();
    const ok = await this.say(t, caption, need);
    device.endHold();
    return ok;
  },

  /** Wait until the state machine reaches `state`, or bail after `maxMs`. */
  async until(t, state, maxMs) {
    let waited = 0;
    while (waited < maxMs && t === this.token && App.state !== state) {
      await sleep(100);
      waited += 100;
    }
    return t === this.token;
  },

  /** The scripted scenario. */
  async play(t) {
    /* -- 1. the 3 second hold -- */
    if (!await this.say(t, 'Step 1 — A woman presses and holds the SOS keychain for 3 seconds. Nothing else is needed.', 1400)) return;
    if (!await this.hold(t, 'Step 1 — Holding… the ring counts down silently. Releasing early would abort.', 'trigger')) return;
    await this.until(t, 'GETTING_LOCATION', 3000);

    /* -- 2. alarm + location -- */
    if (!await this.say(t, 'Step 2 — SOS latched. The siren starts instantly and the GPS module acquires a fix.', 2200)) return;
    if (!await this.say(t, 'Step 2 — Locked on 12 satellites. Her position is now known to within 5 metres.', 1500)) return;

    /* -- 3. SMS to all three contacts -- */
    if (!await this.say(t, 'Step 3 — One SMS carrying the live maps link goes to all 3 trusted contacts, staggered so the radio is never overloaded.', 4400)) return;

    /* -- 4. auto-dial -- */
    if (!await this.until(t, 'CALLING', 4000)) return;
    if (!await this.say(t, 'Step 4 — The device auto-dials contact 1. Nobody has to find a phone or press a call button.', CONFIG.CALL_RING_MS + 400)) return;
    if (!await this.say(t, 'Step 4 — No answer after 5 seconds, so it automatically dials contact 2.', CONFIG.CALL_RING_MS + 400)) return;

    /* -- 5. answered + alarm continues -- */
    if (!await this.say(t, 'Step 5 — Contact 2 answers. A two-way voice channel opens and the guardian has her live location.', 3600)) return;
    if (!await this.say(t, 'Step 5 — The 125 dB siren keeps running so anyone nearby can hear it and look for her.', 3000)) return;

    /* -- 6. cancel gesture -- */
    if (!await this.say(t, 'Recovery — She is safe. Holding the same button for 5 seconds sends "I am safe" to everyone.', 1600)) return;
    if (!await this.hold(t, 'Recovery — Holding for the full 5 seconds… the siren keeps going until she confirms.', 'cancel')) return;
    await this.until(t, 'IDLE', 2500);

    /* -- 7. finish -- */
    if (!await this.say(t, 'Demo complete — that is the whole flow: press, locate, alert, call, alarm, and a safe exit.', 2400)) return;

    $('#captionBar').hidden = true;
    this.stop(true);
    log.add('DEMO', 'Auto-run showcase finished', 'ok');
    device.setMsg('READY', 'info');
  }
};


/* ============================================================================
   12) BOOT
   ========================================================================== */
(function init() {
  log.init();
  device.init();
  phone.init();
  mapView.init();
  controls.init();

  stateMachine.set('IDLE');
  device.setMsg('READY', 'info');
  log.add('SYSTEM', 'SafeHer simulator loaded — no real SMS or calls are made', 'ok');
  log.add('SYSTEM', 'Hold the pink SOS button for 3 seconds to begin', 'info');
  log.add('GPS', `Fix acquired — ${CONFIG.GPS_SATELLITES.good} satellites, ±5m`, 'ok');

  /* keep the map badge honest even while idle */
  setInterval(() => {
    if (!stateMachine.isAlerting()) mapView.updateBadge();
  }, 1000);

  /* live clock in the header + inside the phone mockup */
  const clock = $('#hdrClock');
  if (clock) clock.textContent = nowClock();
  setInterval(() => { if (clock) clock.textContent = nowClock(); }, 1000);

  /* pause the siren when the tab is hidden (saves CPU mid-presentation) */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.setVolume(0);
    else audio.setVolume(audio.running && !App.muted ? 0.11 : 0);
  });
})();
