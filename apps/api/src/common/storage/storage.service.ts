import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

export interface ObjectInfo {
  sizeBytes: number;
  contentType: string | null;
}

/** SPEC §4 "Documents": uploads get 5 minutes, downloads 60 seconds. */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * Private object storage (MinIO in dev/prod, any S3 API). The bucket is private with default server-side
 * encryption (infra's `minio-init`); the API never proxies file bytes, it only hands out short-lived presigned
 * URLs, so no object is ever publicly readable.
 *
 * Presigned URLs embed `S3_ENDPOINT`, so it must be the address browsers use (prod: `https://files.<domain>`
 * through Caddy, SPEC §7); the API reaches MinIO through the same address.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly s3: S3Client;
  readonly bucket: string;

  constructor(config: AppConfig) {
    this.bucket = config.get('S3_BUCKET');
    this.s3 = new S3Client({
      endpoint: config.get('S3_ENDPOINT'),
      region: config.get('S3_REGION'),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY'),
        secretAccessKey: config.get('S3_SECRET_KEY'),
      },
      // MinIO serves buckets as a path, not as a subdomain.
      forcePathStyle: true,
      // Newer SDKs add a CRC32 checksum to every PutObject by default, which a presigned browser PUT cannot send.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  onModuleDestroy(): void {
    this.s3.destroy();
  }

  /**
   * Presigned PUT that only accepts exactly `contentLength` bytes of `contentType`: both headers are part of the
   * signature, so a different size or type is rejected by the storage server itself (403).
   */
  async presignPut(opts: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresIn?: number;
  }): Promise<PresignedUrl> {
    const expiresIn = opts.expiresIn ?? UPLOAD_URL_TTL_SECONDS;
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: opts.key,
        ContentType: opts.contentType,
        ContentLength: opts.contentLength,
      }),
      { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  /** Presigned GET that makes the browser download the file under its original name. */
  async presignGet(opts: {
    key: string;
    fileName: string;
    contentType: string;
    expiresIn?: number;
  }): Promise<PresignedUrl> {
    const expiresIn = opts.expiresIn ?? DOWNLOAD_URL_TTL_SECONDS;
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: opts.key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: contentDisposition(opts.fileName),
      }),
      { expiresIn },
    );
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  /** Size and type of a stored object, or null when it does not exist. */
  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Removes an object. Idempotent: deleting a missing key succeeds (S3 semantics). */
  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof S3ServiceException &&
    (err.$metadata.httpStatusCode === 404 || err.name === 'NotFound' || err.name === 'NoSuchKey')
  );
}

/**
 * `attachment` with an ASCII fallback plus the RFC 5987 UTF-8 name, so "Nalaz – Đorđe.pdf" downloads with its
 * real name and header injection through the file name is impossible.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
