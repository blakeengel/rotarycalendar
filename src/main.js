const activateBtn = document.getElementById('activate');
const landingMsg = document.getElementById('landing-msg');
const wheel = document.getElementById('wheel');
const readout = document.getElementById('readout');

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

let frameQueued = false;
let motionWarmupUntil = 0;

const ROTATION_STEP_DEG = 30;
const LERP = 0.18;
const WARMUP_MS = 900;

const ROLL_RATE_THRESHOLD = 90;
const HYSTERESIS = 0.35;
const RESET_WINDOW_MS = 800;

function scheduleFrame() {
  if (!frameQueued) {
    frameQueued = true;
    requestAnimationFrame(applyFrame);
  }
}

function applyFrame() {
  frameQueued = false;
  currentRotationDeg += (targetRotationDeg - currentRotationDeg) * LERP;
  wheel.style.transform = `rotate(${currentRotationDeg.toFixed(2)}deg)`;
  readout.textContent = `θ ${targetRotationDeg.toFixed(0)}°  (${currentRotationDeg.toFixed(1)}°)`;
  if (Math.abs(targetRotationDeg - currentRotationDeg) > 0.05) {
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
    const isReset =
      this.prevDir !== 0 &&
      flick.dir === -this.prevDir &&
      dtSince < RESET_WINDOW_MS;

    if (isReset) return 0;

    this.prevDir = flick.dir;
    this.prevPeak = flick.peak;
    this.prevEndTs = flick.ts;
    return flick.dir;
  }
}

const rollFlick = new FlickDetector(ROLL_RATE_THRESHOLD);

function onMotion(event) {
  const now = performance.now();
  if (now < motionWarmupUntil) return;

  const rr = event.rotationRate;
  if (rr && rr.gamma != null) {
    const d = rollFlick.update(rr.gamma, now);
    if (d !== 0) {
      targetRotationDeg += d * ROTATION_STEP_DEG;
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
      scheduleFrame();
    })
    .catch((err) => {
      landingMsg.textContent = `Error: ${err.message || err}. Tap to retry.`;
      activateBtn.disabled = false;
    });
}

activateBtn.addEventListener('click', activate);

// Apply the initial rotation immediately so today's day sits at the top even
// in the landing state, behind the blur.
scheduleFrame();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
