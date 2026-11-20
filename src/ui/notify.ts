// Browser notifications, shared by the injury-news scanner and live-pick alerts: a remembered
// on/off switch, a list of what has already been announced, and showing a notification. Phones
// (Chrome on Android) only show notifications through a service worker, so one is registered
// when a switch is turned on; desktop browsers fall back to the page's own Notification.
import { useCallback, useEffect, useState } from 'preact/hooks';

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: nothing to remember */
    }
  },
};

export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;

const granted = () => notifySupported() && Notification.permission === 'granted';

function registerWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the page's own Notification still works on desktop */
  });
}

export interface NotifyToggle {
  supported: boolean;
  on: boolean;
  denied: boolean;
  toggle: () => void;
}

/** An on/off switch for one kind of notification, remembered under `key`. */
export function useNotifyToggle(key: string): NotifyToggle {
  const [on, setOn] = useState(() => store.get(key) === '1');
  const [denied, setDenied] = useState(() => notifySupported() && Notification.permission === 'denied');
  useEffect(() => {
    if (on) registerWorker();
  }, [on]);
  const toggle = useCallback(() => {
    if (on) {
      setOn(false);
      store.set(key, '0');
      return;
    }
    if (!notifySupported()) return;
    void Notification.requestPermission().then((p) => {
      setDenied(p === 'denied');
      if (p === 'granted') {
        setOn(true);
        store.set(key, '1');
      }
    });
  }, [on, key]);
  return { supported: notifySupported(), on, denied, toggle };
}

/**
 * Which of `keys` haven't been announced before, by the list kept under `seenKey` (the last
 * `keep`). Marks them announced, so each key comes back new once only.
 */
export function firstSeen(seenKey: string, keys: string[], keep = 300): string[] {
  let seen: string[] = [];
  try {
    seen = JSON.parse(store.get(seenKey) ?? '[]');
  } catch {
    /* a corrupt list starts over */
  }
  const fresh = [...new Set(keys)].filter((k) => !seen.includes(k));
  if (fresh.length) store.set(seenKey, JSON.stringify([...seen, ...fresh].slice(-keep)));
  return fresh;
}

/** Shows a notification if permission is granted; `tag` replaces an earlier one with the same tag. */
export function showNotification(title: string, body: string, tag: string) {
  if (!granted()) return;
  const page = () => {
    try {
      new Notification(title, { body, tag });
    } catch {
      /* some mobile browsers only notify from a service worker */
    }
  };
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return page();
  navigator.serviceWorker
    .getRegistration()
    .then((reg) => (reg ? reg.showNotification(title, { body, tag }) : page()))
    .catch(page);
}
