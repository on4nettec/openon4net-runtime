'use client';

import { useEffect, useState } from 'react';
import { api } from './api-client';

// RT-083 — the standard set of RTL-script languages. Not exhaustive of every
// ISO code that could theoretically be RTL, but covers what the AI
// translation pipeline (locale-service.ts) and the language pickers
// (settings/login) realistically offer.
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);

export function isRtlLanguage(lang: string): boolean {
  return RTL_LANGUAGES.has(lang.split('-')[0] ?? lang);
}

/**
 * Sets <html lang>/<dir> directly on the DOM. Deliberately not done via
 * layout.tsx (a server component with no session/user knowledge, and this
 * app has no cookie-based SSR session) — every authenticated page that
 * cares about direction calls this once it knows the effective language
 * (user.language ?? organization.language).
 */
export function applyDocumentDirection(lang: string): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtlLanguage(lang) ? 'rtl' : 'ltr';
}

// RT-091 — RT-083 built GET /v1/locales/:lang (reference en.json + on-demand
// AI translation, cached to disk) but no page ever actually called it: every
// UI string was still hard-coded English regardless of the user's chosen
// language. Module-level cache (not component state) so navigating between
// pages — each of which mounts its own <Sidebar>/calls useLocaleStrings
// independently — doesn't refetch the same language's JSON over and over.
const localeCache = new Map<string, Promise<Record<string, string>>>();

function fetchLocale(lang: string): Promise<Record<string, string>> {
  let pending = localeCache.get(lang);
  if (!pending) {
    pending = api.getLocale(lang).then((result) => result.strings);
    localeCache.set(lang, pending);
    // A failed fetch (e.g. AI translation unconfigured for a fresh language)
    // shouldn't permanently poison the cache — the next call should retry.
    pending.catch(() => localeCache.delete(lang));
  }
  return pending;
}

/**
 * Returns a `t(key, fallback)` translator for the given language — `en`
 * resolves instantly from the reference dictionary; any other language
 * fetches (and caches) `strings` from the backend. Always non-blocking:
 * before the fetch resolves (or if it fails, or the key is simply missing),
 * `t()` returns `fallback` so a page never shows a raw key or an empty
 * string, and English-only usage looks identical to before this hook
 * existed.
 */
export function useLocaleStrings(language: string): (key: string, fallback: string) => string {
  const [strings, setStrings] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetchLocale(language)
      .then((result) => {
        if (!cancelled) setStrings(result);
      })
      .catch(() => {
        if (!cancelled) setStrings({});
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  return (key: string, fallback: string) => strings[key] ?? fallback;
}
