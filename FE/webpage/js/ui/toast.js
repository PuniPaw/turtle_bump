import { icon } from '../icons.js';

export function showToast(message, { duration = 2600 } = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${icon('info', { size: 18 })}<span></span>`;
  el.querySelector('span').textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));
  setTimeout(() => {
    el.classList.remove('is-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, duration);
}
