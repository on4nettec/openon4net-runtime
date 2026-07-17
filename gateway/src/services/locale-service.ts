import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from '@o2n/governance';
import type { Env } from '../env.js';

const moduleDirname = path.dirname(fileURLToPath(import.meta.url));
// src/services -> ../../locales (gateway/locales), same relative depth
// whether running from src (tsx) or dist (built) since both sit two levels
// under the gateway package root.
const LOCALES_DIR = path.join(moduleDirname, '../../locales');
const GENERATED_DIR = path.join(LOCALES_DIR, 'generated');

const LANGUAGE_CODE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export function isValidLanguageCode(lang: string): boolean {
  return LANGUAGE_CODE_PATTERN.test(lang);
}

let referenceCache: Record<string, string> | undefined;

async function loadReference(): Promise<Record<string, string>> {
  if (!referenceCache) {
    const raw = await readFile(path.join(LOCALES_DIR, 'en.json'), 'utf-8');
    referenceCache = JSON.parse(raw) as Record<string, string>;
  }
  return referenceCache;
}

export interface LocaleResult {
  language: string;
  strings: Record<string, string>;
  source: 'reference' | 'cached' | 'generated';
}

/**
 * RT-083 — mirrors Control Plane's CP-028 locale-service.ts exactly. 'en' is
 * always the reference file (checked into git); any other language is
 * generated on first request via AI translation and cached to disk, so
 * it's only ever generated once per deployment.
 */
export async function getLocale(env: Env, lang: string): Promise<LocaleResult> {
  if (!isValidLanguageCode(lang)) {
    throw new ValidationError(`Invalid language code: ${lang}`);
  }

  const reference = await loadReference();
  if (lang === 'en') {
    return { language: 'en', strings: reference, source: 'reference' };
  }

  const cachedPath = path.join(GENERATED_DIR, `${lang}.json`);
  if (existsSync(cachedPath)) {
    const raw = await readFile(cachedPath, 'utf-8');
    return { language: lang, strings: JSON.parse(raw) as Record<string, string>, source: 'cached' };
  }

  if (!env.LOCALE_AI_API_KEY) {
    throw new ValidationError(
      `Language '${lang}' is not available yet and AI translation is not configured (LOCALE_AI_API_KEY unset)`,
    );
  }

  const generated = await translateViaAi(env, reference, lang);
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(cachedPath, JSON.stringify(generated, null, 2), 'utf-8');
  return { language: lang, strings: generated, source: 'generated' };
}

async function translateViaAi(
  env: Env,
  reference: Record<string, string>,
  targetLang: string,
): Promise<Record<string, string>> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.LOCALE_AI_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.LOCALE_AI_MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content:
            `Translate the values of this JSON object into the language with ISO code "${targetLang}". ` +
            `Keep every key exactly the same, unchanged. Return ONLY the translated JSON object and nothing else.\n\n` +
            JSON.stringify(reference, null, 2),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new ValidationError(`AI translation request failed with status ${response.status}`);
  }

  const body = (await response.json()) as { content: { type: string; text?: string }[] };
  const text = body.content.find((block) => block.type === 'text')?.text;
  if (!text) throw new ValidationError('AI translation returned no text content');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new ValidationError('AI translation did not return valid JSON');

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, string>;
  const missingKeys = Object.keys(reference).filter((key) => !(key in parsed));
  if (missingKeys.length > 0) {
    throw new ValidationError(`AI translation is missing keys: ${missingKeys.join(', ')}`);
  }
  return parsed;
}
