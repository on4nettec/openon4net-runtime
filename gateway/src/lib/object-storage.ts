import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../env.js';

/**
 * RT-030/RT-025 — thin wrapper over the AWS S3 SDK, pointed at a self-hosted
 * MinIO instance (S3-compatible, so the same client/API works against real
 * AWS S3 later with zero code changes — just different env values).
 * Optional feature: callers must check isObjectStorageConfigured(env)
 * first and degrade gracefully (same convention as SMTP/Marketplace/
 * LOCALE_AI_API_KEY) rather than this module throwing on missing config.
 */
export function isObjectStorageConfigured(env: Env): boolean {
  return Boolean(env.MINIO_ENDPOINT && env.MINIO_ROOT_USER && env.MINIO_ROOT_PASSWORD);
}

function createClient(env: Env): S3Client {
  return new S3Client({
    endpoint: `${env.MINIO_USE_SSL ? 'https' : 'http'}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
    region: 'us-east-1', // MinIO ignores this, but the SDK requires a value
    credentials: { accessKeyId: env.MINIO_ROOT_USER!, secretAccessKey: env.MINIO_ROOT_PASSWORD! },
    forcePathStyle: true, // required for MinIO (vs. AWS S3's virtual-hosted-style)
  });
}

/**
 * Adds a public-read statement scoped to one key prefix (e.g. "branding/*"),
 * merging with whatever policy already exists rather than overwriting it —
 * RT-025's workspace files share this same bucket and must stay private.
 * Discovered the hard way (an earlier version of this function made the
 * *entire bucket* public): a bucket-wide policy would have quietly exposed
 * every org's uploaded workspace files to the internet the moment branding
 * upload was used once. Idempotent — safe to call on every upload.
 */
async function ensurePublicPrefix(client: S3Client, bucket: string, prefix: string): Promise<void> {
  let statements: unknown[] = [];
  try {
    const existing = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    const parsed = JSON.parse(existing.Policy ?? '{"Statement":[]}') as { Statement?: unknown[] };
    statements = parsed.Statement ?? [];
  } catch {
    // No policy yet (fresh bucket) — start from an empty statement list.
  }

  const resource = `arn:aws:s3:::${bucket}/${prefix}`;
  const alreadyPublic = statements.some(
    (s) => typeof s === 'object' && s !== null && JSON.stringify((s as { Resource?: unknown }).Resource).includes(resource),
  );
  if (alreadyPublic) return;

  statements.push({ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [resource] });
  await client.send(
    new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: '2012-10-17', Statement: statements }) }),
  );
}

/** Creates the configured bucket if it doesn't exist yet — self-hosted admins shouldn't need a separate manual MinIO setup step. New buckets are private by default (MinIO's own default); nothing here makes anything public on its own. */
async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export interface UploadResult {
  url: string;
  key: string;
}

/**
 * Uploads a file. `options.public` controls both the returned URL's shape
 * and whether the object is actually fetchable without credentials:
 *  - `public: true` (e.g. branding logos): the key's prefix (everything
 *    before the last `/`) is granted public s3:GetObject, and the returned
 *    URL is a permanent, directly-fetchable link.
 *  - `public: false` (default — e.g. workspace files): the object stays
 *    private; the returned URL is a presigned GetObject URL valid for 1
 *    hour. Callers needing a fresh link later should call
 *    getPresignedDownloadUrl() again rather than caching this one.
 */
export async function uploadFile(
  env: Env,
  key: string,
  body: Buffer,
  contentType: string,
  options: { public?: boolean } = {},
): Promise<UploadResult> {
  if (!isObjectStorageConfigured(env)) {
    throw new Error('Object storage is not configured (MINIO_ENDPOINT/MINIO_ROOT_USER/MINIO_ROOT_PASSWORD unset)');
  }
  const client = createClient(env);
  await ensureBucket(client, env.MINIO_BUCKET);
  await client.send(
    new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );

  if (options.public) {
    const prefix = `${key.slice(0, key.lastIndexOf('/'))}/*`;
    await ensurePublicPrefix(client, env.MINIO_BUCKET, prefix);
    const base =
      env.MINIO_PUBLIC_URL ?? `${env.MINIO_USE_SSL ? 'https' : 'http'}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`;
    return { url: `${base.replace(/\/$/, '')}/${env.MINIO_BUCKET}/${key}`, key };
  }

  const url = await getPresignedDownloadUrl(env, key);
  return { url, key };
}

/** A time-limited (1h) signed URL for a private object — used for workspace files (RT-025), never for public branding assets (those get a permanent public URL from uploadFile itself). */
export async function getPresignedDownloadUrl(env: Env, key: string): Promise<string> {
  const client = createClient(env);
  return getSignedUrl(client, new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key }), { expiresIn: 3600 });
}

export async function deleteFile(env: Env, key: string): Promise<void> {
  const client = createClient(env);
  await client.send(new DeleteObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key }));
}
