import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { registerServiceWorker } from './lib/pwa';
import { initTheme } from './lib/theme';

// Apply the persisted theme and start following live OS changes in "system"
// mode. (index.html already set the initial class inline to avoid a flash;
// this re-applies idempotently and wires up the matchMedia listener.)
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: register the offline-shell + push service worker (no-op where unsupported).
registerServiceWorker();
