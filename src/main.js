const activateBtn = document.getElementById('activate');
const landingMsg = document.getElementById('landing-msg');
const wheel = document.getElementById('wheel');
const readout = document.getElementById('readout');
const connectBtn = document.getElementById('connect');

// OAuth client ID for live Google Calendar sync (client IDs are public
// identifiers, safe to commit). Empty string disables the Connect button and
// the app falls back to the baked events.json snapshot.
const GOOGLE_CLIENT_ID = '971677339251-o2a19jicqkfnd61got9fklp80qh43gc3.apps.googleusercontent.com';
const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

let calendarSvg = null;

// ---- Event rendering. Angle encodes the date (day 1 of the year at the
// bottom, advancing clockwise, one day per 360/366°, matching the SVG's day
// lines); radius encodes time of day (15 units per hour from r=90 at
// midnight to r=450 at the following midnight, matching the hour rings).

const SVG_NS = 'http://www.w3.org/2000/svg';
const HOUR_R0 = 90;
const HOUR_R_PER_H = 15;
const DAY_ANGLE = 360 / 366;

function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d - start) / 86400000) + 1;
}

function drawEvents(svg, events) {
  const prev = svg.querySelector('#event-lines');
  if (prev) prev.remove();
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('id', 'event-lines');
  g.setAttribute('transform', 'translate(600, 600)');
  for (const ev of events) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    if (isNaN(start) || isNaN(end)) continue;
    const day = dayOfYear(start);
    const t0 = start.getHours() + start.getMinutes() / 60;
    const sameDay = start.toDateString() === end.toDateString();
    const t1 = sameDay ? end.getHours() + end.getMinutes() / 60 : 24;
    const ang = ((180 + (day - 0.5) * DAY_ANGLE) * Math.PI) / 180;
    const r0 = HOUR_R0 + t0 * HOUR_R_PER_H;
    // Enforce a minimum radial length so short meetings stay visible.
    const r1 = Math.max(HOUR_R0 + t1 * HOUR_R_PER_H, r0 + 4);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', (r0 * Math.sin(ang)).toFixed(2));
    line.setAttribute('y1', (-r0 * Math.cos(ang)).toFixed(2));
    line.setAttribute('x2', (r1 * Math.sin(ang)).toFixed(2));
    line.setAttribute('y2', (-r1 * Math.cos(ang)).toFixed(2));
    line.setAttribute('class', 'event-line');
    g.appendChild(line);
  }
  svg.appendChild(g);
}

// Swap the <img> for the SVG's real DOM so page CSS and JS can reach inside
// it — needed for hour-ring level-of-detail and for drawing calendar events
// into the dial. The <img> stays as the fallback if this fails.
fetch('./rotary-calendar.svg')
  .then((r) => r.text())
  .then((txt) => {
    const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.nodeName !== 'svg') return;
    svg.setAttribute('id', 'calendar');
    document.getElementById('calendar').replaceWith(svg);
    calendarSvg = svg;
    return fetch('./events.json')
      .then((r) => r.json())
      .then((data) => drawEvents(svg, data.events || []));
  })
  .catch(() => {});

// ---- Live Google Calendar sync (Google Identity Services token flow).
//
// First visit: after motion activation, a centered Connect button runs the
// OAuth consent once and remembers it (localStorage flag). Later visits ride
// along on the Activate tap: a stored token (~1h lifetime) is reused
// silently; when stale, requestAccessToken is called inside the same tap
// gesture — with consent already granted, Google's popup self-closes.

const CONNECTED_KEY = 'gcalConnected';
const TOKEN_KEY = 'gcalToken';

function readStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { t, exp } = JSON.parse(raw);
    // 60s safety margin so we don't start a paginated fetch on a dying token.
    return t && exp && Date.now() < exp - 60000 ? t : null;
  } catch {
    return null;
  }
}

function storeToken(token, expiresInSec) {
  try {
    localStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({ t: token, exp: Date.now() + expiresInSec * 1000 })
    );
  } catch {}
}

async function gcalFetch(token, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendar API ${res.status}`);
  return res.json();
}

async function loadLiveEvents(token) {
  const year = new Date().getFullYear();
  const timeMin = encodeURIComponent(`${year}-01-01T00:00:00Z`);
  const timeMax = encodeURIComponent(`${year + 1}-01-08T00:00:00Z`);

  const calList = await gcalFetch(
    token,
    'https://www.googleapis.com/calendar/v3/users/me/calendarList'
  );

  const events = [];
  for (const cal of calList.items || []) {
    let pageToken = '';
    do {
      const url =
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events` +
        `?singleEvents=true&maxResults=2500&timeMin=${timeMin}&timeMax=${timeMax}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const page = await gcalFetch(token, url);
      for (const ev of page.items || []) {
        if (ev.status === 'cancelled') continue;
        if (!ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) continue; // skip all-day
        events.push({ start: ev.start.dateTime, end: ev.end.dateTime });
      }
      pageToken = page.nextPageToken || '';
    } while (pageToken);
  }
  return events;
}

async function syncWithToken(token) {
  const events = await loadLiveEvents(token);
  if (calendarSvg) drawEvents(calendarSvg, events);
  localStorage.setItem(CONNECTED_KEY, '1');
  return events.length;
}

function showConnectButton(label) {
  connectBtn.textContent = label || 'Connect Google Calendar';
  connectBtn.disabled = false;
  connectBtn.hidden = false;
}

// Must be called from inside a user-gesture handler: opens Google's popup.
// With prior consent the popup closes itself without user interaction.
function requestTokenInteractive() {
  if (typeof google === 'undefined' || !google.accounts) {
    showConnectButton('Google script blocked — tap to retry');
    return;
  }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GCAL_SCOPE,
    callback: async (resp) => {
      if (resp.error || !resp.access_token) {
        showConnectButton();
        return;
      }
      storeToken(resp.access_token, Number(resp.expires_in) || 3600);
      try {
        const n = await syncWithToken(resp.access_token);
        connectBtn.textContent = `Synced ${n} events`;
        setTimeout(() => { connectBtn.hidden = true; }, 1500);
      } catch {
        showConnectButton('Sync failed — tap to retry');
      }
    },
  });
  client.requestAccessToken();
}

// Rides on the Activate tap for returning users. Synchronous decision so the
// popup path stays inside the gesture.
function maybeSyncCalendar() {
  if (!GOOGLE_CLIENT_ID) return;
  if (!localStorage.getItem(CONNECTED_KEY)) return; // first run: onboarding button instead
  const stored = readStoredToken();
  if (stored) {
    syncWithToken(stored).catch(() => {
      localStorage.removeItem(TOKEN_KEY);
      showConnectButton('Reconnect Google Calendar');
    });
  } else {
    requestTokenInteractive();
  }
}

connectBtn.addEventListener('click', () => {
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  requestTokenInteractive();
});

// SVG day-lines start at 6 o'clock (rotate 0 = pointing down) and advance
// clockwise through the year. So today's day-line sits at (180° + yearFraction
// * 360°) measured clockwise from screen top. Rotating the wheel by the
// negative of that angle brings today to the top.
function initialDayRotationDeg() {
  const now = new Date();
  const year = now.getFullYear();
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year + 1, 0, 1);
  const yearFraction = (now - yearStart) / (yearEnd - yearStart);
  const angleFromTop = (180 + yearFraction * 360) % 360;
  return -angleFromTop;
}

let targetRotationDeg = initialDayRotationDeg();
let currentRotationDeg = targetRotationDeg;

let zoomLevel = 0;
let targetScale = 1;
let currentScale = 1;

// Radial pan in screen px. 0 = calendar center exactly on the anchor point.
// Positive pushes the wheel down, bringing outer rings into the viewport.
// Only ever nonzero when zoomed in enough that the slice overflows the screen.
let targetPan = 0;
let currentPan = 0;

let frameQueued = false;
let motionWarmupUntil = 0;

const ROTATION_STEP_DEG = 30;
const LERP = 0.18;
const WARMUP_MS = 900;

const ROLL_RATE_THRESHOLD = 90;    // deg/s
const PITCH_RATE_THRESHOLD = 90;   // deg/s
const Z_ACCEL_THRESHOLD = 2.5;     // m/s²
const HYSTERESIS = 0.35;
const RESET_WINDOW_MS = 800;
const SETTLE_MS = 400;              // swallow ringing after a return motion
const SAME_DIR_REFRACTORY_MS = 300; // swallow same-direction mechanical rebound

const ZOOM_FACTOR = 1.5;
const ZOOM_MIN_LEVEL = -3;
const ZOOM_MAX_LEVEL = 5;

const Z_BASELINE_LERP = 0.05;                        // ~200ms convergence in idle
const Z_IDLE_LIMIT = Z_ACCEL_THRESHOLD * 0.5;        // only update baseline in idle

let zBaseline = 0;

// Hour-ring spacing in the SVG's user units (24 rings, 15 units apart on a
// 1200-unit viewBox); converted to px at the current scale so a tilt flick
// steps exactly one hour.
const RING_SPACING_SVG = 15;
const SVG_SIZE = 1200;
const CROSS_SUPPRESS_MS = 500;
const TOUCH_SUPPRESS_MS = 500;
const SCALE_MIN = Math.pow(ZOOM_FACTOR, ZOOM_MIN_LEVEL);
const SCALE_MAX = Math.pow(ZOOM_FACTOR, ZOOM_MAX_LEVEL);

function anchorToTopPx() {
  return window.innerHeight * 0.5;
}

function panMaxFor(scale) {
  const wheelHalf = (wheel.offsetWidth / 2) * scale;
  return Math.max(0, wheelHalf - anchorToTopPx());
}

function ringStepPx(scale) {
  return (RING_SPACING_SVG / SVG_SIZE) * wheel.offsetWidth * scale;
}

// Zoom-driven level of detail for the hour rings: zoomed out shows only the
// 6-hour rings, one step in adds the 3-hour rings, two or more shows all 24.
function updateLod() {
  wheel.dataset.lod = String(clamp(zoomLevel, 0, 2));
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function scheduleFrame() {
  if (!frameQueued) {
    frameQueued = true;
    requestAnimationFrame(applyFrame);
  }
}

function applyFrame() {
  frameQueued = false;
  currentRotationDeg += (targetRotationDeg - currentRotationDeg) * LERP;
  currentScale += (targetScale - currentScale) * LERP;
  currentPan += (targetPan - currentPan) * LERP;
  // Transforms apply right-to-left: rotate and scale both pivot on the
  // wheel's own center, then the pan translates that center straight down
  // in screen space. Pan is 0 unless traversing rings while zoomed in.
  wheel.style.transform =
    `translate(0, ${currentPan.toFixed(1)}px)` +
    ` scale(${currentScale.toFixed(3)})` +
    ` rotate(${currentRotationDeg.toFixed(2)}deg)`;
  readout.textContent =
    `θ ${targetRotationDeg.toFixed(0)}°  ×${currentScale.toFixed(2)}  z${zoomLevel}` +
    `  f ${Math.round(targetPan)}/${Math.round(panMaxFor(targetScale))}`;
  if (
    Math.abs(targetRotationDeg - currentRotationDeg) > 0.05 ||
    Math.abs(targetScale - currentScale) > 0.005 ||
    Math.abs(targetPan - currentPan) > 0.5
  ) {
    scheduleFrame();
  }
}

// Peak-detects motion segments on a signed signal. Emits +1 or -1 on segment
// end. Opposite-direction segments within RESET_WINDOW_MS with smaller peaks
// are treated as return motions and discarded.
class FlickDetector {
  constructor(threshold) {
    this.threshold = threshold;
    this.endThreshold = threshold * HYSTERESIS;
    this.inMotion = false;
    this.curDir = 0;
    this.curPeak = 0;
    this.prevDir = 0;
    this.prevPeak = 0;
    this.prevEndTs = 0;
    this.settleUntil = 0;
  }

  update(signal, now) {
    const abs = Math.abs(signal);
    const dir = signal >= 0 ? 1 : -1;

    if (!this.inMotion) {
      if (abs > this.threshold) {
        this.inMotion = true;
        this.curDir = dir;
        this.curPeak = abs;
      }
      return 0;
    }

    if (abs > this.threshold && dir !== this.curDir) {
      const finished = { dir: this.curDir, peak: this.curPeak, ts: now };
      const emit = this.finalize(finished);
      this.curDir = dir;
      this.curPeak = abs;
      return emit;
    }

    if (abs < this.endThreshold) {
      const finished = { dir: this.curDir, peak: this.curPeak, ts: now };
      this.inMotion = false;
      return this.finalize(finished);
    }

    if (dir === this.curDir && abs > this.curPeak) {
      this.curPeak = abs;
    }
    return 0;
  }

  finalize(flick) {
    const dtSince = flick.ts - this.prevEndTs;

    // Still ringing after a swallowed return motion — keep swallowing, and
    // extend the window while the oscillation continues.
    if (flick.ts < this.settleUntil) {
      this.settleUntil = flick.ts + SETTLE_MS;
      return 0;
    }

    // Return motion (wrist reset / braking phase of a lunge).
    if (this.prevDir !== 0 && flick.dir === -this.prevDir && dtSince < RESET_WINDOW_MS) {
      this.settleUntil = flick.ts + SETTLE_MS;
      return 0;
    }

    // Mechanical rebound in the same direction as the committed flick —
    // a human can't intentionally repeat a flick this fast.
    if (this.prevDir !== 0 && flick.dir === this.prevDir && dtSince < SAME_DIR_REFRACTORY_MS) {
      return 0;
    }

    this.prevDir = flick.dir;
    this.prevPeak = flick.peak;
    this.prevEndTs = flick.ts;
    return flick.dir;
  }

  suppress(until) {
    this.settleUntil = Math.max(this.settleUntil, until);
  }
}

const rollFlick = new FlickDetector(ROLL_RATE_THRESHOLD);
const zoomFlick = new FlickDetector(Z_ACCEL_THRESHOLD);
const pitchFlick = new FlickDetector(PITCH_RATE_THRESHOLD);

const allFlicks = [rollFlick, zoomFlick, pitchFlick];

// One physical gesture bleeds into other sensor axes (a tilt drags some
// z-accel with it, a lunge wobbles the gyro). Whichever detector commits
// first wins the gesture; the others sit out briefly.
function suppressOthers(committed, now) {
  for (const f of allFlicks) {
    if (f !== committed) f.suppress(now + CROSS_SUPPRESS_MS);
  }
}

function onMotion(event) {
  const now = performance.now();

  // Touch owns the calendar while any finger is down — dragging physically
  // moves the phone and would trip every flick detector.
  if (pointers.size > 0) return;

  // Track the z-accel baseline continuously (even during warmup) so any DC
  // bias present at page load is estimated before we start detecting flicks.
  // Only update inside the idle band so real flick peaks don't drag the
  // baseline toward the direction the user just flicked.
  const acc = event.acceleration;
  if (acc && acc.z != null && Math.abs(acc.z) < Z_IDLE_LIMIT) {
    zBaseline += (acc.z - zBaseline) * Z_BASELINE_LERP;
  }

  if (now < motionWarmupUntil) return;

  const rr = event.rotationRate;
  if (rr && rr.gamma != null) {
    const d = rollFlick.update(rr.gamma, now);
    if (d !== 0) {
      targetRotationDeg += d * ROTATION_STEP_DEG;
      suppressOthers(rollFlick, now);
      scheduleFrame();
    }
  }

  // Spec says +z points out of the screen toward the user, but iOS Safari
  // reports the opposite sign (verified on hardware: a push toward the face
  // read negative). Negate so toward-face → positive → zoom in.
  if (acc && acc.z != null) {
    const zCentered = -(acc.z - zBaseline);
    const d = zoomFlick.update(zCentered, now);
    if (d !== 0) {
      zoomLevel = clamp(zoomLevel + d, ZOOM_MIN_LEVEL, ZOOM_MAX_LEVEL);
      targetScale = Math.pow(ZOOM_FACTOR, zoomLevel);
      // Rescale the pan so the ring band in view stays put, then re-clamp —
      // zooming out shrinks the traversable range and can pull the pan in.
      targetPan = clamp(targetPan * Math.pow(ZOOM_FACTOR, d), 0, panMaxFor(targetScale));
      updateLod();
      suppressOthers(zoomFlick, now);
      scheduleFrame();
    }
  }

  // Pitch rate → ring traversal. Per spec, tipping the top of the device
  // toward the user reads positive beta; the brief maps tilt-toward-face to
  // outward (pan grows), tilt-away to inward. Sign unverified on hardware.
  if (rr && rr.beta != null) {
    const d = pitchFlick.update(rr.beta, now);
    if (d !== 0) {
      const panMax = panMaxFor(targetScale);
      const next = clamp(targetPan + d * ringStepPx(targetScale), 0, panMax);
      if (next === targetPan) {
        // Whole slice already visible, or at the end of the range — bounce:
        // kick the visible pan and let the lerp spring it back to target.
        currentPan += d * Math.min(64, anchorToTopPx() * 0.08);
      } else {
        targetPan = next;
      }
      suppressOthers(pitchFlick, now);
      scheduleFrame();
    }
  }
}

// The DeviceMotionEvent.requestPermission call MUST happen synchronously
// inside the click handler on iOS Safari — any await before it drops the
// user-gesture context and the prompt silently fails.
function activate() {
  if (activateBtn.disabled) return;
  activateBtn.disabled = true;
  landingMsg.textContent = '';

  const needsPrompt =
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function';
  const permissionPromise = needsPrompt
    ? DeviceMotionEvent.requestPermission()
    : Promise.resolve('granted');

  // Returning users: calendar sync shares this same tap gesture (a popup
  // opened later, outside the gesture, would be blocked).
  maybeSyncCalendar();

  // Guard against the prompt hanging so a stuck permission call doesn't
  // leave the button permanently disabled.
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('permission timed out')), 8000)
  );

  Promise.race([permissionPromise, timeout])
    .then((state) => {
      if (state !== 'granted') {
        landingMsg.textContent = 'Motion permission denied. Enable Motion & Orientation in Safari settings and reload.';
        activateBtn.disabled = false;
        return;
      }
      motionWarmupUntil = performance.now() + WARMUP_MS;
      window.addEventListener('devicemotion', onMotion);
      document.body.classList.add('active');
      readout.hidden = false;
      // First run: offer the one-time calendar connect over the revealed dial.
      if (GOOGLE_CLIENT_ID && !localStorage.getItem(CONNECTED_KEY)) {
        showConnectButton();
      }
      scheduleFrame();
    })
    .catch((err) => {
      landingMsg.textContent = `Error: ${err.message || err}. Tap to retry.`;
      activateBtn.disabled = false;
    });
}

// ---- Touch gestures: one finger drags (dx → rotate, dy → traverse rings),
// two fingers pinch (→ zoom). Pointer events cover mouse drags for free.

const pointers = new Map();
let pinchStartDist = 0;
let pinchStartScale = 1;
let pinchStartPan = 0;

function initPinch() {
  const [a, b] = [...pointers.values()];
  pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
  pinchStartScale = targetScale;
  pinchStartPan = targetPan;
}

function onPointerDown(e) {
  if (!document.body.classList.contains('active')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) initPinch();
}

function onPointerMove(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;

  if (pointers.size === 1) {
    // Rim-drag feel: most interaction happens near the top of the visible
    // dial, ~anchorToTop px from the wheel center, so dx over that distance
    // approximates dragging the rim 1:1.
    targetRotationDeg += (dx / anchorToTopPx()) * (180 / Math.PI);
    targetPan = clamp(targetPan + dy, 0, panMaxFor(targetScale));
    scheduleFrame();
  } else if (pointers.size === 2 && pinchStartDist > 0) {
    const [a, b] = [...pointers.values()];
    const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinchStartDist;
    targetScale = clamp(pinchStartScale * ratio, SCALE_MIN, SCALE_MAX);
    // Keep the discrete zoom level in step so a later motion flick continues
    // from where the pinch left off.
    zoomLevel = clamp(
      Math.round(Math.log(targetScale) / Math.log(ZOOM_FACTOR)),
      ZOOM_MIN_LEVEL,
      ZOOM_MAX_LEVEL
    );
    targetPan = clamp(pinchStartPan * ratio, 0, panMaxFor(targetScale));
    updateLod();
    scheduleFrame();
  }
}

function onPointerEnd(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size === 2) initPinch();
  else pinchStartDist = 0;
  if (pointers.size === 0) {
    // Lifting fingers jolts the phone — don't let it read as a flick.
    const until = performance.now() + TOUCH_SUPPRESS_MS;
    for (const f of allFlicks) f.suppress(until);
  }
}

window.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerEnd);
window.addEventListener('pointercancel', onPointerEnd);

activateBtn.addEventListener('click', activate);

// Apply the initial rotation immediately so today's day sits at the top even
// in the landing state, behind the blur.
updateLod();
scheduleFrame();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
