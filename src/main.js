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

// Orbit-ring spacing in the SVG's user units (concentric circles are ~17.85
// apart on a 1200-unit viewBox); converted to px at the current scale to step
// exactly one ring per tilt flick.
const RING_SPACING_SVG = 17.85;
const SVG_SIZE = 1200;
const CROSS_SUPPRESS_MS = 500;
const TOUCH_SUPPRESS_MS = 500;
const SCALE_MIN = Math.pow(ZOOM_FACTOR, ZOOM_MIN_LEVEL);
const SCALE_MAX = Math.pow(ZOOM_FACTOR, ZOOM_MAX_LEVEL);

function anchorToTopPx() {
  return window.innerHeight * 0.95;
}

function panMaxFor(scale) {
  const wheelHalf = (wheel.offsetWidth / 2) * scale;
  return Math.max(0, wheelHalf - anchorToTopPx());
}

function ringStepPx(scale) {
  return (RING_SPACING_SVG / SVG_SIZE) * wheel.offsetWidth * scale;
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
scheduleFrame();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
