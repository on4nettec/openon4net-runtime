import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from '@o2n/governance';
import type { Env } from '../env.js';
import { createTestEnv } from '../test-support/env.js';
import { getLocale, isValidLanguageCode } from './locale-service.js';

const moduleDirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(moduleDirname, '../../locales/generated');

function testEnv(overrides: Partial<Env> = {}): Env {
  return createTestEnv({ LOCALE_AI_API_KEY: undefined, ...overrides });
}

describe('locale-service (RT-083)', () => {
  const testLangCode = 'zz'; // never a real language — avoids clobbering a real cache file

  afterEach(async () => {
    await rm(path.join(GENERATED_DIR, `${testLangCode}.json`), { force: true });
  });

  it('validates language code shape', () => {
    expect(isValidLanguageCode('en')).toBe(true);
    expect(isValidLanguageCode('en-US')).toBe(true);
    expect(isValidLanguageCode('fa')).toBe(true);
    expect(isValidLanguageCode('english')).toBe(false);
    expect(isValidLanguageCode('EN')).toBe(false);
    expect(isValidLanguageCode('')).toBe(false);
  });

  it('rejects an invalid language code', async () => {
    await expect(getLocale(testEnv(), 'not-a-lang-code')).rejects.toBeInstanceOf(ValidationError);
  });

  it('"en" always returns the real reference file, never needs AI', async () => {
    const result = await getLocale(testEnv(), 'en');
    expect(result.source).toBe('reference');
    expect(result.language).toBe('en');
    expect(result.strings['chat.title']).toBe('Chat');
  });

  it('an uncached non-English language with no AI key configured throws a clear error', async () => {
    await expect(getLocale(testEnv(), testLangCode)).rejects.toThrow(
      /not available yet and AI translation is not configured/,
    );
  });

  it('a cached generated file is returned without needing an AI key — real filesystem, not a mock', async () => {
    await mkdir(GENERATED_DIR, { recursive: true });
    await writeFile(path.join(GENERATED_DIR, `${testLangCode}.json`), JSON.stringify({ 'chat.title': 'Test Title' }), 'utf-8');

    const result = await getLocale(testEnv(), testLangCode);
    expect(result.source).toBe('cached');
    expect(result.strings['chat.title']).toBe('Test Title');
  });
});
