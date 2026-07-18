import { describe, it, expect } from 'vitest';
import { createTestEnv } from '../test-support/env.js';
import { deleteFile, isObjectStorageConfigured, uploadFile } from './object-storage.js';

// RT-030/RT-025 — real integration test against an actual MinIO instance
// (not mocked), same "real infra, not stubs" testing convention as the rest
// of this project. Requires MINIO_ENDPOINT/MINIO_ROOT_USER/MINIO_ROOT_PASSWORD
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
  function realEnv(bucket: string) {
    return createTestEnv({
      MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
      MINIO_PORT: Number(process.env.MINIO_PORT ?? 9000),
      MINIO_ROOT_USER: process.env.MINIO_ROOT_USER,
      MINIO_ROOT_PASSWORD: process.env.MINIO_ROOT_PASSWORD,
      MINIO_BUCKET: bucket,
    });
  }

  it('public: true returns a permanent URL that is fetchable without any credentials', async () => {
    const env = realEnv('o2n-files-test-public');
    const content = Buffer.from('public branding asset', 'utf8');
    const result = await uploadFile(env, `branding/test-org/logo-${Date.now()}.txt`, content, 'text/plain', {
      public: true,
    });

    const fetched = await fetch(result.url);
    expect(fetched.ok).toBe(true);
    expect(await fetched.text()).toBe('public branding asset');
  });

  it(
    'default (private) returns a presigned URL, and the object is NOT reachable via a plain (unsigned) direct URL — ' +
      'this is exactly the bug an earlier version of ensureBucket() had: it made the whole bucket public',
    async () => {
      const env = realEnv('o2n-files-test-private');
      const key = `workspaces/test-workspace/${Date.now()}-secret.txt`;
      const content = Buffer.from('this must stay private', 'utf8');
      const result = await uploadFile(env, key, content, 'text/plain');

      // The presigned URL works...
      const viaPresigned = await fetch(result.url);
      expect(viaPresigned.ok).toBe(true);
      expect(await viaPresigned.text()).toBe('this must stay private');

      // ...but a naive direct/unsigned URL to the same object must NOT.
      const base = `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT ?? 9000}`;
      const viaUnsignedDirectUrl = await fetch(`${base}/o2n-files-test-private/${key}`);
      expect(viaUnsignedDirectUrl.ok).toBe(false);

      await deleteFile(env, key);
    },
  );

  it('uploading a public branding file does not make a previously-uploaded private file in the same bucket public', async () => {
    const env = realEnv('o2n-files-test-mixed');
    const privateKey = `workspaces/org-1/${Date.now()}-private.txt`;
    await uploadFile(env, privateKey, Buffer.from('private'), 'text/plain');

    // Now upload something public, under a different prefix, same bucket.
    await uploadFile(env, `branding/org-1/logo-${Date.now()}.txt`, Buffer.from('public'), 'text/plain', {
      public: true,
    });

    const base = `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT ?? 9000}`;
    const stillPrivate = await fetch(`${base}/o2n-files-test-mixed/${privateKey}`);
    expect(stillPrivate.ok).toBe(false);

    await deleteFile(env, privateKey);
  });
});
