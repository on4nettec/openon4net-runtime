'use client';

import { useEffect } from 'react';

export function RegisterServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Non-fatal — the app works fully without a service worker, this
        // only affects install/offline-shell behavior.
      });
    }
  }, []);

  return null;
}
