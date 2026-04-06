import { App } from './app';

const container = document.getElementById('app')!;
const app = new App(container);

// Fade out splash, fade in canvas
const loading = document.getElementById('loading');
const canvas = container.querySelector('canvas');
if (canvas) canvas.classList.add('tt-ready');
if (loading) {
  loading.classList.add('tt-fade-out');
  loading.addEventListener('transitionend', () => loading.remove(), { once: true });
}

// Cleanup on HMR
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    app.dispose();
  });
}
