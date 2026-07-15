const activateBtn = document.getElementById('activate');
const landingMsg = document.getElementById('landing-msg');
const wheel = document.getElementById('wheel');
const readout = document.getElementById('readout');

// Target state — advanced discretely by flicks.
let targetRotationDeg = 0;
let zoomLevel = 0;
let focalLevel = 0;

// Interpolated visible state — lerps toward target every frame.
let currentRotationDeg = 0;
let currentScale = 1;
let currentFocalPct = 0;

let frameQueued = false;
let motionWarmupUntil = 0;

const ROTATION_STEP_DEG = 30;      // one month per flick
const ZOOM_FACTOR = 1.5;
const ZOOM_MIN_LEVEL = -3;
const ZOOM_MAX_LEVEL = 8;
const FOCAL_STEP_PCT = 3.75;       // shifts calendar ~4% of its box per flick
const FOCAL_MIN_LEVEL = -2;
const FOCAL_MAX_LEVEL = 10;
const LERP = 0.18;                 // fraction of remaining gap closed per frame
const WARMUP_MS = 900;             // ignore sensor input during landing → active transition

// Flick detection thresholds — chosen high enough to reject hand tremor.
const ROLL_RATE_THRESHOLD = 90;    // deg/s around device Y (roll)
const PITCH_RATE_THRESHOLD = 90;   // deg/s around device X (pitch)
const Z_ACCEL_THRESHOLD = 2.2;     // m/s² along device Z (toward/away from face)
const HYSTERESIS = 0.35;           // motion segment ends only when |signal| < threshold * HYSTERESIS

const RESET_WINDOW_MS = 1000;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function targetScale() {
  return Math.pow(ZOOM_FACTOR, zoomLevel);
}

function targetFocalPct() {
  return -focalLevel * FOCAL_STEP_PCT;
}

function scheduleFrame() {
  if (!frameQueued) {
    frameQueued = true;
    requestAnimationFrame(applyFrame);
  }
}

function applyFrame() {
  frameQueued = false;
  const tr = targetRotationDeg;
  const ts = targetScale();
  const tf = targetFocalPct();
  currentRotationDeg += (tr - currentRotationDeg) * LERP;
  currentScale += (ts - currentScale) * LERP;
  currentFocalPct += (tf - currentFocalPct) * LERP;

  wheel.style.transform =
    `scale(${currentScale.toFixed(3)})` +
    ` rotate(${currentRotationDeg.toFixed(2)}deg)` +
    ` translate(0, ${currentFocalPct.toFixed(2)}%)`;

  readout.textContent =
    `θ ${targetRotationDeg.toFixed(0)}°  ×${currentScale.toFixed(2)}  zoom ${zoomLevel}  focal ${focalLevel}`;

  if (
    Math.abs(tr - currentRotationDeg) > 0.05 ||
    Math.abs(ts - currentScale) > 0.005 ||
    Math.abs(tf - currentFocalPct) > 0.02
  ) {
    scheduleFrame();
  }
}

// Peak-detects a motion segment on a signed signal. A flick is committed only
// when the segment ends. A newly-ended segment counts as a "reset" (and is
// discarded) if the previous flick was opposite-direction, ended within
// RESET_WINDOW_MS, and had a bigger peak.
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

    // Reversal above the entry threshold — end the current segment, start a new one.
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
    const isReset =
      this.prevDir !== 0 &&
      flick.dir === -this.prevDir &&
      dtSince < RESET_WINDOW_MS &&
      flick.peak < this.prevPeak;

    if (isReset) {
      // Discarded. Leave `prev*` untouched so a subsequent motion is still
      // compared against the same original primary.
      return 0;
    }

    this.prevDir = flick.dir;
    this.prevPeak = flick.peak;
    this.prevEndTs = flick.ts;
    return flick.dir;
  }
}

const rollFlick = new FlickDetector(ROLL_RATE_THRESHOLD);
const pitchFlick = new FlickDetector(PITCH_RATE_THRESHOLD);
const zoomFlick = new FlickDetector(Z_ACCEL_THRESHOLD);

function onMotion(event) {
  const now = performance.now();
  if (now < motionWarmupUntil) return;

  const rr = event.rotationRate;
  if (rr) {
    if (rr.gamma != null) {
      // Roll rate → month rotation. Sign chosen so twisting the top of the
      // device to the right (clockwise from user POV) advances one month.
      const d = rollFlick.update(rr.gamma, now);
      if (d !== 0) targetRotationDeg += d * ROTATION_STEP_DEG;
    }
    if (rr.beta != null) {
      // Pitch rate → focal ring. Tilting the top away from face = negative
      // pitch rate on iOS = focal moves inward (level decreases).
      const d = pitchFlick.update(rr.beta, now);
      if (d !== 0) {
        focalLevel = clamp(focalLevel + d, FOCAL_MIN_LEVEL, FOCAL_MAX_LEVEL);
      }
    }
  }

  const acc = event.acceleration || event.accelerationIncludingGravity;
  if (acc && acc.z != null) {
    // +z acceleration = phone thrust toward face (screen normal points at user).
    const d = zoomFlick.update(acc.z, now);
    if (d !== 0) {
      zoomLevel = clamp(zoomLevel + d, ZOOM_MIN_LEVEL, ZOOM_MAX_LEVEL);
    }
  }

  scheduleFrame();
}

async function requestMotionPermission() {
  if (
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function'
  ) {
    return DeviceMotionEvent.requestPermission();
  }
  return 'granted';
}

async function activate() {
  activateBtn.disabled = true;
  landingMsg.textContent = '';
  try {
    const state = await requestMotionPermission();
    if (state !== 'granted') {
      landingMsg.textContent = 'Motion permission denied. Enable Motion & Orientation in Safari settings and reload.';
      activateBtn.disabled = false;
      return;
    }

    motionWarmupUntil = performance.now() + WARMUP_MS;
    window.addEventListener('devicemotion', onMotion);

    document.body.classList.add('active');
    readout.hidden = false;
    scheduleFrame();
  } catch (err) {
    landingMsg.textContent = `Error: ${err.message || err}`;
    activateBtn.disabled = false;
  }
}

activateBtn.addEventListener('click', activate);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
