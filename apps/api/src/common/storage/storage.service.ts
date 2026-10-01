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
import { Readable } from 'node:stream';
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
 * Two clients, same credentials:
 *  - `s3` talks to `S3_ENDPOINT` for server-side calls (HEAD/DELETE). In prod that is `http://minio:9000` on the
 *    internal Docker network, so the API never hairpins through the public internet.
 *  - `presigner` only signs URLs (offline, never sends a request) for `S3_PUBLIC_ENDPOINT`, the address browsers
 *    use (prod: `https://files.<domain>` through Caddy, SPEC §7). SigV4 signs the Host header, so the proxy must
 *    forward that host unchanged. Without `S3_PUBLIC_ENDPOINT` both use `S3_ENDPOINT` (dev, e2e).
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly s3: S3Client;
  private readonly presigner: S3Client;
  readonly bucket: string;

  constructor(config: AppConfig) {
    this.bucket = config.get('S3_BUCKET');
    const endpoint = config.get('S3_ENDPOINT');
    const publicEndpoint = config.get('S3_PUBLIC_ENDPOINT') ?? endpoint;
    const client = (url: string) =>
      new S3Client({
        endpoint: url,
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
    this.s3 = client(endpoint);
    this.presigner = publicEndpoint === endpoint ? this.s3 : client(publicEndpoint);
  }

  onModuleDestroy(): void {
    this.s3.destroy();
    if (this.presigner !== this.s3) this.presigner.destroy();
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
      this.presigner,
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
      this.presigner,
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

  /** The object's bytes as a Node stream (server-side reads, e.g. the client data export), or null when missing. */
  async read(key: string): Promise<Readable | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body instanceof Readable ? res.Body : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
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
