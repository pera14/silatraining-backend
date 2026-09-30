import { AuthResponse, JoinAcceptResponse, JoinInfo, JoinLinkResponse } from '@sila/contracts';
import {
  createJoinLink,
  createTestApp,
  createUser,
  login,
  resetDb,
  setCookies,
  type TestContext,
} from './setup/app';

const newPerson = {
  firstName: 'Paige',
  lastName: 'Sullivan',
  email: 'paige@sila.test',
  phone: '+381 64 000 1111',
  password: 'Paige-strong-1',
  consent: true,
};

describe('join a trainer (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
  });

  async function trainerWithLink() {
    const trainer = await createUser(ctx.prisma, 'TRAINER', {
      firstName: 'Mark',
      lastName: 'Harris',
    });
    const token = await createJoinLink(ctx.prisma, trainer.id);
    return { trainer, token };
  }

  describe('GET /api/join/:token', () => {
    it('shows the trainer for an active link', async () => {
      const { token } = await trainerWithLink();
      const res = await ctx.http().get(`/api/join/${token}`).expect(200);
      expect(JoinInfo.parse(res.body)).toEqual({
        trainerName: 'Mark Harris',
        trainerFirstName: 'Mark',
        trainerPhotoUrl: null,
      });
    });

    it('returns 410 LINK_REVOKED for revoked and unknown links', async () => {
      const trainer = await createUser(ctx.prisma, 'TRAINER');
      const revoked = await createJoinLink(ctx.prisma, trainer.id, { revoked: true });
      for (const token of [revoked, 'this-token-does-not-exist-at-all']) {
        const res = await ctx.http().get(`/api/join/${token}`).expect(410);
        expect(res.body.code).toBe('LINK_REVOKED');
      }
    });
  });

  describe('new user: POST /api/join/:token/register', () => {
    it('creates a consenting client linked to the trainer and signs them in', async () => {
      const { trainer, token } = await trainerWithLink();
      const res = await ctx
        .http()
        .post(`/api/join/${token}/register`)
        .send({ ...newPerson, email: 'Paige@SILA.test' })
        .expect(201);

      const body = AuthResponse.parse(res.body);
      expect(body.user).toMatchObject({
        role: 'CLIENT',
        email: 'paige@sila.test',
        trainer: { id: trainer.id, firstName: 'Mark' },
      });
      expect(body.user.consentAt).not.toBeNull();
      expect(setCookies(res).some((c) => c.startsWith('sila_refresh='))).toBe(true);
      expect(
        await ctx.prisma.trainerClient.findUnique({ where: { clientId: body.user.id } }),
      ).toMatchObject({ trainerId: trainer.id, archivedAt: null });

      // the new account works like any other
      await ctx
        .http()
        .get('/api/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
      await login(ctx, 'paige@sila.test', newPerson.password);
    });

    it('treats an empty phone as absent', async () => {
      const { token } = await trainerWithLink();
      const res = await ctx
        .http()
        .post(`/api/join/${token}/register`)
        .send({ ...newPerson, phone: '' })
        .expect(201);
      expect(res.body.user.phone).toBeNull();
    });

    it('requires consent', async () => {
      const { token } = await trainerWithLink();
      const res = await ctx
        .http()
        .post(`/api/join/${token}/register`)
        .send({ ...newPerson, consent: false })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await ctx.prisma.user.count({ where: { role: 'CLIENT' } })).toBe(0);
    });

    it('rejects an email that already has an account', async () => {
      const { token } = await trainerWithLink();
      await createUser(ctx.prisma, 'CLIENT', { email: 'paige@sila.test' });
      const res = await ctx.http().post(`/api/join/${token}/register`).send(newPerson).expect(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
    });

    it('refuses a revoked link', async () => {
      const trainer = await createUser(ctx.prisma, 'TRAINER');
      const token = await createJoinLink(ctx.prisma, trainer.id, { revoked: true });
      const res = await ctx.http().post(`/api/join/${token}/register`).send(newPerson).expect(410);
      expect(res.body.code).toBe('LINK_REVOKED');
      expect(await ctx.prisma.user.count({ where: { role: 'CLIENT' } })).toBe(0);
    });
  });

  describe('existing client: POST /api/join/:token/accept', () => {
    it('links a signed-in client without a trainer', async () => {
      const { trainer, token } = await trainerWithLink();
      const client = await createUser(ctx.prisma, 'CLIENT');
      const { accessToken } = await login(ctx, client.email);

      const res = await ctx
        .http()
        .post(`/api/join/${token}/accept`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(JoinAcceptResponse.parse(res.body)).toEqual({
        trainerName: 'Mark Harris',
        linked: true,
      });
      const me = await ctx
        .http()
        .get('/api/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(me.body.trainer.id).toBe(trainer.id);
    });

    it('is idempotent for the same trainer', async () => {
      const { trainer, token } = await trainerWithLink();
      const client = await createUser(ctx.prisma, 'CLIENT');
      await ctx.prisma.trainerClient.create({
        data: { trainerId: trainer.id, clientId: client.id },
      });
      const { accessToken } = await login(ctx, client.email);
      const res = await ctx
        .http()
        .post(`/api/join/${token}/accept`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body).toEqual({ trainerName: 'Mark Harris', linked: false });
    });

    it('returns 409 ALREADY_LINKED when the client belongs to another trainer', async () => {
      const { token } = await trainerWithLink();
      const other = await createUser(ctx.prisma, 'TRAINER', { firstName: 'Jovana' });
      const client = await createUser(ctx.prisma, 'CLIENT');
      await ctx.prisma.trainerClient.create({ data: { trainerId: other.id, clientId: client.id } });
      const { accessToken } = await login(ctx, client.email);

      const res = await ctx
        .http()
        .post(`/api/join/${token}/accept`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
      expect(res.body.code).toBe('ALREADY_LINKED');
      expect(
        (await ctx.prisma.trainerClient.findUnique({ where: { clientId: client.id } }))?.trainerId,
      ).toBe(other.id);
    });

    it('returns 410 for a revoked link', async () => {
      const trainer = await createUser(ctx.prisma, 'TRAINER');
      const token = await createJoinLink(ctx.prisma, trainer.id, { revoked: true });
      const client = await createUser(ctx.prisma, 'CLIENT');
      const { accessToken } = await login(ctx, client.email);
      await ctx
        .http()
        .post(`/api/join/${token}/accept`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(410);
    });

    it('requires sign-in', async () => {
      const { token } = await trainerWithLink();
      await ctx.http().post(`/api/join/${token}/accept`).expect(401);
    });
  });

  describe('wrong role', () => {
    it('forbids a trainer from accepting an invite', async () => {
      const { token } = await trainerWithLink();
      const otherTrainer = await createUser(ctx.prisma, 'TRAINER');
      const { accessToken } = await login(ctx, otherTrainer.email);
      const res = await ctx
        .http()
        .post(`/api/join/${token}/accept`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('forbids a client from reading or regenerating a join link', async () => {
      const client = await createUser(ctx.prisma, 'CLIENT');
      const { accessToken } = await login(ctx, client.email);
      await ctx
        .http()
        .get('/api/trainer/join-link')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
      await ctx
        .http()
        .post('/api/trainer/join-link/regenerate')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });
  });

  describe('trainer join link', () => {
    it('is created once, shown as URL + QR SVG, and regenerating revokes the old one', async () => {
      const trainer = await createUser(ctx.prisma, 'TRAINER');
      const { accessToken } = await login(ctx, trainer.email);
      const auth = { Authorization: `Bearer ${accessToken}` };

      const first = JoinLinkResponse.parse(
        (await ctx.http().get('/api/trainer/join-link').set(auth).expect(200)).body,
      );
      const again = JoinLinkResponse.parse(
        (await ctx.http().get('/api/trainer/join-link').set(auth).expect(200)).body,
      );
      expect(again.url).toBe(first.url);
      expect(first.url).toMatch(/^http:\/\/localhost:3001\/join\/[A-Za-z0-9_-]{43}$/);
      expect(first.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
      // only the hash is stored
      const row = await ctx.prisma.joinLink.findFirstOrThrow({ where: { trainerId: trainer.id } });
      expect(first.url).not.toContain(row.tokenHash);

      const regenerated = JoinLinkResponse.parse(
        (await ctx.http().post('/api/trainer/join-link/regenerate').set(auth).expect(200)).body,
      );
      expect(regenerated.url).not.toBe(first.url);
      const oldToken = first.url.split('/').pop()!;
      const newToken = regenerated.url.split('/').pop()!;
      await ctx.http().get(`/api/join/${oldToken}`).expect(410);
      await ctx.http().get(`/api/join/${newToken}`).expect(200);
      expect(
        await ctx.prisma.joinLink.count({ where: { trainerId: trainer.id, revokedAt: null } }),
      ).toBe(1);
    });
  });
});
