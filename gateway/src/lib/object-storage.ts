import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import type { Env } from '../env.js';

/**
 * RT-030 — thin wrapper over the AWS S3 SDK, pointed at a self-hosted
 * MinIO instance (S3-compatible, so the same client/API works against
 * real AWS S3 later with zero code changes — just different env values).
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
 * Creates the configured bucket if it doesn't exist yet — self-hosted
 * admins shouldn't need a separate manual MinIO setup step. Also sets a
 * public-read bucket policy: branding logos need to be viewable by anyone
 * loading the login page, not just authenticated API callers, and MinIO
 * buckets default to fully private (discovered by an earlier version of
 * this test uploading successfully but the returned URL 403ing on fetch).
 */
async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: '*',
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${bucket}/*`],
            },
          ],
        }),
      }),
    );
  }
}

export interface UploadResult {
  url: string;
  key: string;
}

/**
 * Uploads a file and returns a URL it can be fetched from.
 * MINIO_PUBLIC_URL (an org's own reverse-proxy in front of MinIO) is
 * preferred when set; otherwise falls back to a direct MinIO URL — fine
 * for local dev, not for a real deployment where MinIO's port typically
 * isn't internet-facing.
 */
export async function uploadFile(
  env: Env,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<UploadResult> {
  if (!isObjectStorageConfigured(env)) {
    throw new Error('Object storage is not configured (MINIO_ENDPOINT/MINIO_ROOT_USER/MINIO_ROOT_PASSWORD unset)');
  }
  const client = createClient(env);
  await ensureBucket(client, env.MINIO_BUCKET);
  await client.send(
    new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );

  const base =
    env.MINIO_PUBLIC_URL ?? `${env.MINIO_USE_SSL ? 'https' : 'http'}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`;
  return { url: `${base.replace(/\/$/, '')}/${env.MINIO_BUCKET}/${key}`, key };
}
