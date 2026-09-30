import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateDocumentResponse, Document, DocumentDownloadResponse } from '@sila/contracts';
import { z } from 'zod';
import { StorageService } from '../src/common/storage/storage.service';
import { DocumentsPurgeCron } from '../src/modules/documents/documents-purge.cron';
import { DocumentsService } from '../src/modules/documents/documents.service';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { clientOf, trainer } from './scheduling/fixtures';

const PDF = Buffer.from(
  '%PDF-1.4\n% SILA test document\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n',
);
const DAY = 86_400_000;

/** Browser-style upload to the presigned URL. */
function put(url: string, body: Buffer, contentType: string) {
  return fetch(url, { method: 'PUT', body, headers: { 'Content-Type': contentType } });
}

describe('documents on real MinIO (e2e)', () => {
  let ctx: SchedulingContext;
  let s3: S3Client;

  beforeAll(async () => {
    ctx = await createSchedulingApp();
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
      forcePathStyle: true,
    });
  });
  afterAll(async () => {
    s3?.destroy();
    await ctx?.app.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
  });

  async function setup() {
    const t = await trainer(ctx);
    const c = await clientOf(ctx, t.user.id);
    return { t, c };
  }

  async function startUpload(
    api: Awaited<ReturnType<typeof trainer>>['api'],
    clientId: string,
    body: { fileName: string; mimeType: string; sizeBytes: number },
  ) {
    const res = await api.post(`/trainer/clients/${clientId}/documents`).send(body).expect(201);
    return CreateDocumentResponse.parse(res.body);
  }

  async function uploaded(
    api: Awaited<ReturnType<typeof trainer>>['api'],
    clientId: string,
    fileName = 'Nalaz – Đorđe.pdf',
  ) {
    const up = await startUpload(api, clientId, {
      fileName,
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    expect((await put(up.uploadUrl, PDF, 'application/pdf')).status).toBe(200);
    await api.post(`/trainer/documents/${up.documentId}/confirm`).expect(200);
    return up.documentId;
  }

  it('create → PUT → confirm → list → download (audit-logged) → soft delete (audit-logged)', async () => {
    const { t, c } = await setup();
    const up = await startUpload(t.api, c.user.id, {
      fileName: 'Nalaz – Đorđe.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
    });

    // presigned PUT valid 5 min, key built from UUIDs only
    const putUrl = new URL(up.uploadUrl);
    expect(putUrl.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(putUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(putUrl.pathname).toBe(
      `/${process.env.S3_BUCKET}/documents/${c.user.id}/${up.documentId}`,
    );
    const expiresIn = Date.parse(up.expiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(290_000);
    expect(expiresIn).toBeLessThanOrEqual(300_000);

    // pending uploads are not listed
    expect((await t.api.get(`/trainer/clients/${c.user.id}/documents`).expect(200)).body).toEqual(
      [],
    );

    expect((await put(up.uploadUrl, PDF, 'application/pdf')).status).toBe(200);
    const confirmed = Document.parse(
      (await t.api.post(`/trainer/documents/${up.documentId}/confirm`).expect(200)).body,
    );
    expect(confirmed).toMatchObject({
      id: up.documentId,
      clientId: c.user.id,
      fileName: 'Nalaz – Đorđe.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    expect(confirmed.confirmedAt).not.toBeNull();
    // idempotent
    await t.api.post(`/trainer/documents/${up.documentId}/confirm`).expect(200);

    // stored encrypted at rest (bucket default SSE)
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: `documents/${c.user.id}/${up.documentId}`,
      }),
    );
    expect(head.ServerSideEncryption).toBe('AES256');

    const list = z
      .array(Document)
      .parse((await t.api.get(`/trainer/clients/${c.user.id}/documents`).expect(200)).body);
    expect(list.map((d) => d.id)).toEqual([up.documentId]);

    // download: presigned GET valid 60 s that serves the same bytes with the original name
    const dl = DocumentDownloadResponse.parse(
      (await t.api.get(`/trainer/documents/${up.documentId}/download`).expect(200)).body,
    );
    expect(new URL(dl.url).searchParams.get('X-Amz-Expires')).toBe('60');
    const file = await fetch(dl.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toBe(
      `attachment; filename="Nalaz _ _or_e.pdf"; filename*=UTF-8''Nalaz%20%E2%80%93%20%C4%90or%C4%91e.pdf`,
    );

    // the bucket itself is private
    const anonymous = await fetch(
      `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/documents/${c.user.id}/${up.documentId}`,
    );
    expect(anonymous.status).toBe(403);

    await t.api.delete(`/trainer/documents/${up.documentId}`).expect(204);
    expect((await t.api.get(`/trainer/clients/${c.user.id}/documents`).expect(200)).body).toEqual(
      [],
    );
    await t.api.get(`/trainer/documents/${up.documentId}/download`).expect(404);
    await t.api.delete(`/trainer/documents/${up.documentId}`).expect(404);

    const audit = await ctx.prisma.auditLog.findMany({
      where: { entity: 'Document', entityId: up.documentId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => [a.action, a.actorId])).toEqual([
      ['document.download', t.user.id],
      ['document.delete', t.user.id],
    ]);
    // ids only: the file name may itself be health data and the audit trail outlives the client
    expect(audit[0]!.meta).toEqual({ clientId: c.user.id });
  });

  it('the presigned PUT only accepts the declared size and type', async () => {
    const { t, c } = await setup();
    const up = await startUpload(t.api, c.user.id, {
      fileName: 'scan.png',
      mimeType: 'image/png',
      sizeBytes: 100,
    });
    expect((await put(up.uploadUrl, Buffer.alloc(101), 'image/png')).status).toBe(403);
    expect((await put(up.uploadUrl, Buffer.alloc(100), 'application/pdf')).status).toBe(403);
    expect((await put(up.uploadUrl, Buffer.alloc(100), 'image/png')).status).toBe(200);
    await t.api.post(`/trainer/documents/${up.documentId}/confirm`).expect(200);
  });

  it('confirm before the upload is 422 UPLOAD_INVALID; a mismatching object is removed', async () => {
    const { t, c } = await setup();
    const up = await startUpload(t.api, c.user.id, {
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    const early = await t.api.post(`/trainer/documents/${up.documentId}/confirm`).expect(422);
    expect(early.body.code).toBe('UPLOAD_INVALID');

    // An object that bypassed the signed constraints (written directly with storage credentials).
    const storage = ctx.app.get(StorageService);
    const doc = await ctx.prisma.document.findUniqueOrThrow({ where: { id: up.documentId } });
    const rogue = await storage.presignPut({
      key: doc.s3Key,
      contentType: 'image/png',
      contentLength: 5,
    });
    expect((await put(rogue.url, Buffer.from('12345'), 'image/png')).status).toBe(200);

    const res = await t.api.post(`/trainer/documents/${up.documentId}/confirm`).expect(422);
    expect(res.body.code).toBe('UPLOAD_INVALID');
    expect(await storage.head(doc.s3Key)).toBeNull();
    expect(
      (await ctx.prisma.document.findUniqueOrThrow({ where: { id: up.documentId } })).confirmedAt,
    ).toBeNull();
  });

  it('validates type and the 20 MB limit before issuing a URL', async () => {
    const { t, c } = await setup();
    const tooBig = await t.api
      .post(`/trainer/clients/${c.user.id}/documents`)
      .send({ fileName: 'big.pdf', mimeType: 'application/pdf', sizeBytes: 20 * 1024 * 1024 + 1 })
      .expect(400);
    expect(tooBig.body.code).toBe('VALIDATION_FAILED');
    await t.api
      .post(`/trainer/clients/${c.user.id}/documents`)
      .send({ fileName: 'max.pdf', mimeType: 'application/pdf', sizeBytes: 20 * 1024 * 1024 })
      .expect(201);
    for (const mimeType of ['text/html', 'image/svg+xml', 'application/zip']) {
      await t.api
        .post(`/trainer/clients/${c.user.id}/documents`)
        .send({ fileName: 'x', mimeType, sizeBytes: 10 })
        .expect(400);
    }
    for (const mimeType of [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/heic',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]) {
      await t.api
        .post(`/trainer/clients/${c.user.id}/documents`)
        .send({ fileName: 'ok', mimeType, sizeBytes: 10 })
        .expect(201);
    }
  });

  it('never uses the file name in the key and strips paths from the display name', async () => {
    const { t, c } = await setup();
    const up = await startUpload(t.api, c.user.id, {
      fileName: '../../etc/passwd.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
    });
    const doc = await ctx.prisma.document.findUniqueOrThrow({ where: { id: up.documentId } });
    expect(doc.s3Key).toBe(`documents/${c.user.id}/${up.documentId}`);
    expect(doc.fileName).toBe('passwd.pdf');
  });

  it('nightly purge: objects deleted 30+ days ago and abandoned uploads go; recent ones stay', async () => {
    const { t, c } = await setup();
    const storage = ctx.app.get(StorageService);
    const old = await uploaded(t.api, c.user.id, 'old.pdf');
    const recent = await uploaded(t.api, c.user.id, 'recent.pdf');
    const kept = await uploaded(t.api, c.user.id, 'kept.pdf');
    await t.api.delete(`/trainer/documents/${old}`).expect(204);
    await t.api.delete(`/trainer/documents/${recent}`).expect(204);
    const abandoned = await startUpload(t.api, c.user.id, {
      fileName: 'never-confirmed.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    expect((await put(abandoned.uploadUrl, PDF, 'application/pdf')).status).toBe(200);

    const now = new Date();
    await ctx.prisma.document.update({
      where: { id: old },
      data: { deletedAt: new Date(now.getTime() - 30 * DAY - 60_000) },
    });
    await ctx.prisma.document.update({
      where: { id: recent },
      data: { deletedAt: new Date(now.getTime() - 29 * DAY) },
    });
    await ctx.prisma.document.update({
      where: { id: abandoned.documentId },
      data: { createdAt: new Date(now.getTime() - 25 * 3_600_000) },
    });
    const keys = Object.fromEntries(
      (await ctx.prisma.document.findMany()).map((d) => [d.id, d.s3Key]),
    );

    await ctx.app.get(DocumentsPurgeCron).run(now);

    expect(await storage.head(keys[old]!)).toBeNull();
    expect(await storage.head(keys[abandoned.documentId]!)).toBeNull();
    expect(await storage.head(keys[recent]!)).not.toBeNull();
    expect(await storage.head(keys[kept]!)).not.toBeNull();
    const remaining = (await ctx.prisma.document.findMany()).map((d) => d.id);
    expect(remaining.sort()).toEqual([kept, recent].sort());
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'document.purge', actorId: 'system' } }),
    ).toBe(2);

    // a second run finds nothing
    expect(await ctx.app.get(DocumentsService).purge(now)).toEqual({
      deleted: 0,
      abandoned: 0,
      failed: 0,
    });
  });

  it('an archived client’s documents stay reachable for their trainer', async () => {
    const t = await trainer(ctx);
    const c = await clientOf(ctx, t.user.id);
    const id = await uploaded(t.api, c.user.id);
    await ctx.prisma.trainerClient.update({
      where: { clientId: c.user.id },
      data: { archivedAt: new Date() },
    });
    expect(
      (await t.api.get(`/trainer/clients/${c.user.id}/documents`).expect(200)).body,
    ).toHaveLength(1);
    await t.api.get(`/trainer/documents/${id}/download`).expect(200);
  });

  it("cross-trainer: trainer B gets 404 on A's documents and nothing is logged", async () => {
    const a = await trainer(ctx, 'A');
    const b = await trainer(ctx, 'B');
    const c = await clientOf(ctx, a.user.id);
    const id = await uploaded(a.api, c.user.id);
    const pending = await startUpload(a.api, c.user.id, {
      fileName: 'p.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
    });

    for (const res of [
      await b.api.get(`/trainer/clients/${c.user.id}/documents`),
      await b.api
        .post(`/trainer/clients/${c.user.id}/documents`)
        .send({ fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10 }),
      await b.api.post(`/trainer/documents/${pending.documentId}/confirm`),
      await b.api.get(`/trainer/documents/${id}/download`),
      await b.api.delete(`/trainer/documents/${id}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    expect(await ctx.prisma.auditLog.count()).toBe(0);
    expect((await ctx.prisma.document.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
    // the client themself has no access at all
    const res = await (await clientOf(ctx, a.user.id)).api.get(`/trainer/documents/${id}/download`);
    expect(res.status).toBe(403);
  });
});
