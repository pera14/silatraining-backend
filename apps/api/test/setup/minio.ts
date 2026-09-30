import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';

declare global {
  var __SILA_MINIO__: StartedMinioContainer | undefined;
}

/** Same maintained MinIO fork as infra/docker-compose.dev.yml (upstream images are gone from Docker Hub). */
const MINIO_IMAGE = 'pgsty/minio:latest';
const USER = 'sila-test';
const PASSWORD = 'sila-test-secret';
/** Static SSE key, like the dev compose file: lets the bucket enforce server-side encryption as in prod. */
const KMS_KEY = 'sila-test-key:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

export interface S3TestEnv {
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_BUCKET: string;
  S3_REGION: string;
}

/**
 * Real object storage for the documents e2e suite.
 * - `TEST_S3_ENDPOINT` (+ `TEST_S3_ACCESS_KEY` / `TEST_S3_SECRET_KEY`) set: use that MinIO, e.g. `pnpm infra:up`.
 * - otherwise: one MinIO container per run (Testcontainers, Docker required; CI).
 * Either way the test bucket is created private with default SSE-S3, like infra's `minio-init`.
 */
export async function startObjectStorage(bucket: string): Promise<S3TestEnv> {
  let env: S3TestEnv;
  if (process.env.TEST_S3_ENDPOINT) {
    env = {
      S3_ENDPOINT: process.env.TEST_S3_ENDPOINT,
      S3_ACCESS_KEY: process.env.TEST_S3_ACCESS_KEY ?? 'sila',
      S3_SECRET_KEY: process.env.TEST_S3_SECRET_KEY ?? 'sila-minio-secret',
      S3_BUCKET: bucket,
      S3_REGION: 'us-east-1',
    };
  } else {
    const container = await new MinioContainer(MINIO_IMAGE)
      .withUsername(USER)
      .withPassword(PASSWORD)
      .withEnvironment({ MINIO_KMS_SECRET_KEY: KMS_KEY })
      .start();
    globalThis.__SILA_MINIO__ = container;
    env = {
      S3_ENDPOINT: container.getConnectionUrl(),
      S3_ACCESS_KEY: USER,
      S3_SECRET_KEY: PASSWORD,
      S3_BUCKET: bucket,
      S3_REGION: 'us-east-1',
    };
  }
  await ensureBucket(env);
  return env;
}

async function ensureBucket(env: S3TestEnv): Promise<void> {
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    forcePathStyle: true,
  });
  try {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
    }
    await s3.send(
      new PutBucketEncryptionCommand({
        Bucket: env.S3_BUCKET,
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        },
      }),
    );
  } finally {
    s3.destroy();
  }
}
