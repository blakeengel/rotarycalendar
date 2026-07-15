const wheel = document.getElementById('wheel');
const enableBtn = document.getElementById('enable');
const readout = document.getElementById('readout');

let latestGamma = 0;
let rafPending = false;

function apply() {
  rafPending = false;
  const angle = latestGamma;
  wheel.style.transform = `rotate(${angle.toFixed(2)}deg)`;
  readout.textContent = `γ ${angle.toFixed(1)}°`;
}

function onOrientation(event) {
  const gamma = event.gamma;
  if (gamma == null) return;
  latestGamma = gamma;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(apply);
  }
}

function startListening() {
  window.addEventListener('deviceorientation', onOrientation);
  enableBtn.hidden = true;
}

const needsPermission =
  typeof DeviceOrientationEvent !== 'undefined' &&
  typeof DeviceOrientationEvent.requestPermission === 'function';

if (needsPermission) {
  enableBtn.hidden = false;
  enableBtn.addEventListener('click', async () => {
    try {
      const state = await DeviceOrientationEvent.requestPermission();
      if (state === 'granted') {
        startListening();
      } else {
        readout.textContent = 'motion permission denied';
      }
    } catch (err) {
      readout.textContent = `permission error: ${err.message}`;
    }
  });
} else if (typeof DeviceOrientationEvent !== 'undefined') {
  startListening();
} else {
  readout.textContent = 'device orientation not supported';
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
