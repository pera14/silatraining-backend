import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateDocumentResponse } from '@sila/contracts';
import { strFromU8, unzipSync } from 'fflate';
import type { Response } from 'supertest';
import { resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { addPackage, addSlot, clientOf, local, trainer } from './scheduling/fixtures';

const PDF = Buffer.from('%PDF-1.4\n% SILA export test\n%%EOF\n');

/** Collects a binary response body (supertest buffers JSON/text only). */
function binary(res: Response, done: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

describe('client data: export + delete, SPEC §7 (e2e, real MinIO)', () => {
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
    ctx.clock.set('2026-10-05T08:00:00Z');
  });

  /** A client with a package, a practice, a note, a plan and one uploaded document. */
  async function richClient() {
    const t = await trainer(ctx);
    const c = await clientOf(ctx, t.user.id, { firstName: 'Ana', lastName: 'Đorđević' });
    const pkg = await addPackage(ctx, {
      trainerId: t.user.id,
      clientId: c.user.id,
      validFrom: '2026-10-01',
      validUntil: '2026-10-31',
      paid: true,
    });
    const slot = await addSlot(ctx, t.user.id, local('2026-10-06', '18:00'));
    await t.api
      .post('/trainer/sessions')
      .send({ slotId: slot.id, clientId: c.user.id })
      .expect(201);
    await t.api
      .post(`/trainer/clients/${c.user.id}/notes`)
      .send({ body: 'Left knee: no deep lunges.', pinned: true })
      .expect(201);
    await t.api.post(`/trainer/clients/${c.user.id}/plans`).send({ name: 'Plan A' }).expect(201);
    const up = CreateDocumentResponse.parse(
      (
        await t.api
          .post(`/trainer/clients/${c.user.id}/documents`)
          .send({ fileName: 'Nalaz.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length })
          .expect(201)
      ).body,
    );
    const put = await fetch(up.uploadUrl, {
      method: 'PUT',
      body: PDF,
      headers: { 'Content-Type': 'application/pdf' },
    });
    expect(put.status).toBe(200);
    await t.api.post(`/trainer/documents/${up.documentId}/confirm`).expect(200);
    const doc = await ctx.prisma.document.findUniqueOrThrow({ where: { id: up.documentId } });
    return { t, c, pkg, doc };
  }

  const exists = (key: string) =>
    s3
      .send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }))
      .then(() => true)
      .catch(() => false);

  it('exports a zip with data.json and the documents, and audit-logs it', async () => {
    const { t, c, pkg, doc } = await richClient();

    const res = await t.api
      .get(`/trainer/clients/${c.user.id}/export`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="sila-client-dordevic-\d{4}-\d{2}-\d{2}\.zip"/,
    );

    const files = unzipSync(new Uint8Array(res.body as Buffer));
    expect(Object.keys(files).sort()).toEqual(['data.json', `documents/${doc.id}-Nalaz.pdf`]);
    expect(Buffer.from(files[`documents/${doc.id}-Nalaz.pdf`]!)).toEqual(PDF);

    const data = JSON.parse(strFromU8(files['data.json']!));
    expect(data).toMatchObject({
      format: 1,
      client: { id: c.user.id, email: c.user.email, lastName: 'Đorđević' },
      packages: [{ id: pkg.id, usage: { used: 1 } }],
      practices: [{ status: 'BOOKED', startsAt: '2026-10-06T16:00:00.000Z' }],
      notes: [{ body: 'Left knee: no deep lunges.', pinned: true }],
      plans: [{ name: 'Plan A' }],
      documents: [{ id: doc.id, fileName: 'Nalaz.pdf', path: `documents/${doc.id}-Nalaz.pdf` }],
    });
    // never leaks secrets or storage internals
    const raw = strFromU8(files['data.json']!);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('s3Key');

    expect(
      await ctx.prisma.auditLog.findMany({
        where: { action: 'client.export', entityId: c.user.id },
      }),
    ).toEqual([expect.objectContaining({ actorId: t.user.id, meta: { documents: 1 } })]);
  });

  it('deletes the client for good: account, related rows and stored files; audit keeps no personal data', async () => {
    const { t, c, doc } = await richClient();
    expect(await exists(doc.s3Key)).toBe(true);

    await t.api.delete(`/trainer/clients/${c.user.id}`).expect(204);

    expect(await exists(doc.s3Key)).toBe(false);
    expect(await ctx.prisma.user.findUnique({ where: { id: c.user.id } })).toBeNull();
    for (const count of await Promise.all([
      ctx.prisma.trainerClient.count({ where: { clientId: c.user.id } }),
      ctx.prisma.package.count({ where: { clientId: c.user.id } }),
      ctx.prisma.session.count({ where: { clientId: c.user.id } }),
      ctx.prisma.clientNote.count({ where: { clientId: c.user.id } }),
      ctx.prisma.plan.count({ where: { clientId: c.user.id } }),
      ctx.prisma.document.count({ where: { clientId: c.user.id } }),
      ctx.prisma.refreshToken.count({ where: { userId: c.user.id } }),
    ]))
      expect(count).toBe(0);
    // the trainer and their own data stay
    expect(await ctx.prisma.user.findUnique({ where: { id: t.user.id } })).not.toBeNull();

    const [audit] = await ctx.prisma.auditLog.findMany({
      where: { action: 'client.delete', entityId: c.user.id },
    });
    expect(audit).toMatchObject({
      actorId: t.user.id,
      meta: { documents: 1, practices: 1, packages: 1 },
    });
    expect(JSON.stringify(audit)).not.toContain(c.user.email);

    // the deleted client can no longer use the app; a second delete is 404
    await c.api.get('/client/home').expect(401);
    await t.api.delete(`/trainer/clients/${c.user.id}`).expect(404);
  });

  it.each(['export', 'delete'] as const)(
    '%s: 401 anonymous, 403 for a client, 404 for another trainer’s client or a trainer',
    async (action) => {
      const { t, c, doc } = await richClient();
      const stranger = await trainer(ctx, 'Jovana');
      const call = (api: typeof t.api | null, id = c.user.id) => {
        const path =
          action === 'export' ? `/trainer/clients/${id}/export` : `/trainer/clients/${id}`;
        if (!api) return ctx.http()[action === 'export' ? 'get' : 'delete'](`/api${path}`);
        return action === 'export' ? api.get(path) : api.delete(path);
      };

      expect((await call(null)).status).toBe(401);
      expect((await call(c.api)).status).toBe(403);
      expect((await call(stranger.api)).body.code).toBe('NOT_FOUND');
      // a trainer id is never a "client" of anyone
      expect((await call(t.api, stranger.user.id)).status).toBe(404);

      // nothing was touched
      expect(await ctx.prisma.user.findUnique({ where: { id: c.user.id } })).not.toBeNull();
      expect(await exists(doc.s3Key)).toBe(true);
    },
  );
});
