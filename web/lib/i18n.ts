'use client';

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
