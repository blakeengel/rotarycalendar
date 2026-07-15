const activateBtn = document.getElementById('activate');
const landingMsg = document.getElementById('landing-msg');
const wheel = document.getElementById('wheel');
const readout = document.getElementById('readout');

let gamma = 0;
let zoomVel = 0;
let zoomPos = 0;
let lastMotionTs = 0;
let frameQueued = false;

const DEAD_Z = 0.15;
const VEL_DAMP = 0.9;
const POS_DAMP = 0.95;
const POS_LIMIT = 1.5;
const SCALE_GAIN = 0.5;
const SCALE_MIN = 0.5;
const SCALE_MAX = 2.5;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function applyFrame() {
  frameQueued = false;
  const scale = clamp(1 + zoomPos * SCALE_GAIN, SCALE_MIN, SCALE_MAX);
  wheel.style.transform = `rotate(${gamma.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
  readout.textContent = `γ ${gamma.toFixed(1)}°  z ${zoomPos.toFixed(2)}  ×${scale.toFixed(2)}`;
}

function queueFrame() {
  if (!frameQueued) {
    frameQueued = true;
    requestAnimationFrame(applyFrame);
  }
}

function onOrientation(event) {
  if (event.gamma == null) return;
  gamma = event.gamma;
  queueFrame();
}

function onMotion(event) {
  const linear = event.acceleration;
  const acc = linear && linear.z != null ? linear : event.accelerationIncludingGravity;
  if (!acc || acc.z == null) return;

  const now = performance.now();
  const dt = lastMotionTs ? Math.min(0.1, (now - lastMotionTs) / 1000) : 1 / 60;
  lastMotionTs = now;

  let az = acc.z;
  if (Math.abs(az) < DEAD_Z) az = 0;

  zoomVel = zoomVel * VEL_DAMP + az * dt;
  zoomPos = clamp(zoomPos * POS_DAMP + zoomVel * dt, -POS_LIMIT, POS_LIMIT);
  queueFrame();
}

async function requestPermissions() {
  const needOrient =
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function';
  const needMotion =
    typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function';

  const orientPromise = needOrient
    ? DeviceOrientationEvent.requestPermission()
    : Promise.resolve('granted');
  const motionPromise = needMotion
    ? DeviceMotionEvent.requestPermission()
    : Promise.resolve('granted');

  const [orientState, motionState] = await Promise.all([orientPromise, motionPromise]);
  return { orientState, motionState };
}

async function activate() {
  activateBtn.disabled = true;
  landingMsg.textContent = '';
  try {
    const { orientState, motionState } = await requestPermissions();
    const orientOk = orientState === 'granted';
    const motionOk = motionState === 'granted';

    if (!orientOk && !motionOk) {
      landingMsg.textContent = 'Motion permissions denied. Enable Motion & Orientation in Safari settings and reload.';
      activateBtn.disabled = false;
      return;
    }

    if (orientOk) window.addEventListener('deviceorientation', onOrientation);
    if (motionOk) window.addEventListener('devicemotion', onMotion);

    document.body.classList.add('active');
    readout.hidden = false;
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
