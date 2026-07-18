import { describe, it, expect } from 'vitest';
import { createTestEnv } from '../test-support/env.js';
import { isObjectStorageConfigured, uploadFile } from './object-storage.js';

// RT-030 — real integration test against an actual MinIO instance (not
// mocked), same "real infra, not stubs" testing convention as the rest of
// this project. Requires MINIO_ENDPOINT/MINIO_ROOT_USER/MINIO_ROOT_PASSWORD
// pointed at a running MinIO — skipped automatically otherwise so this
// suite doesn't fail in an environment without one.
const minioAvailable = Boolean(process.env.MINIO_ENDPOINT);
const describeIfMinio = minioAvailable ? describe : describe.skip;

describe('isObjectStorageConfigured', () => {
  it('is false when MinIO env vars are unset', () => {
    const env = createTestEnv();
    expect(isObjectStorageConfigured(env)).toBe(false);
  });

  it('is true once endpoint/user/password are all set', () => {
    const env = createTestEnv({
      MINIO_ENDPOINT: 'localhost',
      MINIO_ROOT_USER: 'test',
      MINIO_ROOT_PASSWORD: 'test',
    });
    expect(isObjectStorageConfigured(env)).toBe(true);
  });
});

describeIfMinio('uploadFile (real MinIO)', () => {
  it('uploads a file and returns a URL it can actually be fetched back from', async () => {
    const env = createTestEnv({
      MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
      MINIO_PORT: Number(process.env.MINIO_PORT ?? 9000),
      MINIO_ROOT_USER: process.env.MINIO_ROOT_USER,
      MINIO_ROOT_PASSWORD: process.env.MINIO_ROOT_PASSWORD,
      MINIO_BUCKET: 'o2n-files-test-v2',
    });

    const content = Buffer.from('hello from a real RT-030 test', 'utf8');
    const result = await uploadFile(env, `test/${Date.now()}.txt`, content, 'text/plain');

    expect(result.url).toContain('o2n-files-test');

    const fetched = await fetch(result.url);
    expect(fetched.ok).toBe(true);
    expect(await fetched.text()).toBe('hello from a real RT-030 test');
  });
});
