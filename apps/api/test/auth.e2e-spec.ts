import { AuthResponse, Me } from '@sila/contracts';
import {
  PASSWORD,
  cookiePair,
  createTestApp,
  createUser,
  login,
  resetDb,
  setCookies,
  type TestContext,
} from './setup/app';

describe('auth (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    ctx.mailer.sent.length = 0;
  });

  describe('POST /api/auth/login', () => {
    it('returns an access token + user and sets the refresh and role-hint cookies', async () => {
      const trainer = await createUser(ctx.prisma, 'TRAINER', { email: 'coach@sila.test' });
      const res = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: 'COACH@sila.test ', password: PASSWORD })
        .expect(200);

      const body = AuthResponse.parse(res.body);
      expect(body.user).toMatchObject({ id: trainer.id, role: 'TRAINER', trainer: null });
      const cookies = setCookies(res);
      const refresh = cookies.find((c) => c.startsWith('sila_refresh='))!;
      expect(refresh).toMatch(/HttpOnly/i);
      expect(refresh).toMatch(/Path=\/api\/auth/);
      expect(refresh).toMatch(/SameSite=Lax/i);
      expect(cookies.find((c) => c.startsWith('sila_session='))).toMatch(/Path=\/;/);
    });

    it('rejects a wrong password and an unknown email identically', async () => {
      await createUser(ctx.prisma, 'CLIENT', { email: 'ana@sila.test' });
      for (const body of [
        { email: 'ana@sila.test', password: 'wrong-password' },
        { email: 'nobody@sila.test', password: PASSWORD },
      ]) {
        const res = await ctx.http().post('/api/auth/login').send(body).expect(401);
        expect(res.body).toEqual({ code: 'INVALID_CREDENTIALS', message: expect.any(String) });
      }
    });

    it('validates input with the contract schema', async () => {
      const res = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: 'not-an-email' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'email' })]),
      );
    });
  });

  describe('GET /api/me', () => {
    it('requires a bearer token', async () => {
      const res = await ctx.http().get('/api/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      await ctx.http().get('/api/me').set('Authorization', 'Bearer garbage').expect(401);
    });

    it('returns the current user and role', async () => {
      const client = await createUser(ctx.prisma, 'CLIENT');
      const { accessToken } = await login(ctx, client.email);
      const res = await ctx
        .http()
        .get('/api/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(Me.parse(res.body)).toMatchObject({ id: client.id, role: 'CLIENT', trainer: null });
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('rotates the refresh token', async () => {
      const user = await createUser(ctx.prisma, 'CLIENT');
      const first = await login(ctx, user.email);
      const res = await ctx
        .http()
        .post('/api/auth/refresh')
        .set('Cookie', cookiePair(first.cookies, 'sila_refresh'))
        .expect(200);

      expect(AuthResponse.parse(res.body).user.id).toBe(user.id);
      expect(cookiePair(setCookies(res), 'sila_refresh')).not.toBe(
        cookiePair(first.cookies, 'sila_refresh'),
      );
      expect(
        await ctx.prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } }),
      ).toBe(1);
    });

    it('treats reuse of a rotated token as theft and revokes every session of the user', async () => {
      const user = await createUser(ctx.prisma, 'CLIENT');
      const a = cookiePair((await login(ctx, user.email)).cookies, 'sila_refresh');
      const b = cookiePair(
        setCookies(await ctx.http().post('/api/auth/refresh').set('Cookie', a).expect(200)),
        'sila_refresh',
      );

      // move the rotation of A outside the grace window
      await ctx.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 60_000) },
      });
      const reuse = await ctx.http().post('/api/auth/refresh').set('Cookie', a).expect(401);
      expect(reuse.body.code).toBe('TOKEN_INVALID');
      // the legitimate successor B is now revoked too
      await ctx.http().post('/api/auth/refresh').set('Cookie', b).expect(401);
    });

    it('tolerates a parallel refresh inside the grace window without revoking the new token', async () => {
      const user = await createUser(ctx.prisma, 'CLIENT');
      const a = cookiePair((await login(ctx, user.email)).cookies, 'sila_refresh');
      const b = cookiePair(
        setCookies(await ctx.http().post('/api/auth/refresh').set('Cookie', a).expect(200)),
        'sila_refresh',
      );
      await ctx.http().post('/api/auth/refresh').set('Cookie', a).expect(401);
      await ctx.http().post('/api/auth/refresh').set('Cookie', b).expect(200);
    });

    it('rejects a missing or unknown cookie', async () => {
      expect((await ctx.http().post('/api/auth/refresh').expect(401)).body.code).toBe(
        'TOKEN_INVALID',
      );
      await ctx.http().post('/api/auth/refresh').set('Cookie', 'sila_refresh=nope').expect(401);
    });
  });

  it('POST /api/auth/logout revokes the refresh token and clears cookies', async () => {
    const user = await createUser(ctx.prisma, 'TRAINER');
    const refresh = cookiePair((await login(ctx, user.email)).cookies, 'sila_refresh');
    const res = await ctx.http().post('/api/auth/logout').set('Cookie', refresh).expect(204);
    expect(setCookies(res).join(';')).toMatch(/sila_refresh=;/);
    await ctx.http().post('/api/auth/refresh').set('Cookie', refresh).expect(401);
  });

  describe('password reset', () => {
    it('emails a single-use link that sets a new password and signs out other sessions', async () => {
      const user = await createUser(ctx.prisma, 'CLIENT', { email: 'forgetful@sila.test' });
      const oldRefresh = cookiePair((await login(ctx, user.email)).cookies, 'sila_refresh');

      await ctx
        .http()
        .post('/api/auth/password/forgot')
        .send({ email: 'forgetful@sila.test' })
        .expect(204);
      expect(ctx.mailer.sent).toHaveLength(1);
      const token = /\/reset\/([A-Za-z0-9_-]+)/.exec(ctx.mailer.sent[0]!.text)![1]!;

      await ctx
        .http()
        .post('/api/auth/password/reset')
        .send({ token, password: 'Brand-new-pass-1' })
        .expect(204);
      await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: 'Brand-new-pass-1' })
        .expect(200);
      await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(401);
      await ctx.http().post('/api/auth/refresh').set('Cookie', oldRefresh).expect(401);

      const again = await ctx
        .http()
        .post('/api/auth/password/reset')
        .send({ token, password: 'Another-pass-2' })
        .expect(400);
      expect(again.body.code).toBe('RESET_TOKEN_INVALID');
    });

    it('does not reveal whether an email exists', async () => {
      await ctx
        .http()
        .post('/api/auth/password/forgot')
        .send({ email: 'ghost@sila.test' })
        .expect(204);
      expect(ctx.mailer.sent).toHaveLength(0);
    });

    it('rejects expired tokens', async () => {
      const user = await createUser(ctx.prisma, 'CLIENT');
      await ctx.http().post('/api/auth/password/forgot').send({ email: user.email }).expect(204);
      const token = /\/reset\/([A-Za-z0-9_-]+)/.exec(ctx.mailer.sent[0]!.text)![1]!;
      await ctx.prisma.passwordReset.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await ctx
        .http()
        .post('/api/auth/password/reset')
        .send({ token, password: 'Brand-new-pass-1' })
        .expect(400);
    });
  });

  describe('profile', () => {
    it('lets each role update only its own profile and requires the current password to change it', async () => {
      const client = await createUser(ctx.prisma, 'CLIENT');
      const { accessToken } = await login(ctx, client.email);
      const auth = { Authorization: `Bearer ${accessToken}` };

      const res = await ctx
        .http()
        .patch('/api/client/profile')
        .set(auth)
        .send({ firstName: 'Anica', phone: '+381 60 1234567' })
        .expect(200);
      expect(res.body).toMatchObject({ firstName: 'Anica', phone: '+381 60 1234567' });

      await ctx.http().patch('/api/trainer/profile').set(auth).send({ firstName: 'X' }).expect(403);
      const bad = await ctx
        .http()
        .patch('/api/client/profile')
        .set(auth)
        .send({ password: { current: 'wrong', next: 'Another-pass-2' } })
        .expect(401);
      expect(bad.body.code).toBe('INVALID_CREDENTIALS');
      await ctx
        .http()
        .patch('/api/client/profile')
        .set(auth)
        .send({ password: { current: PASSWORD, next: 'Another-pass-2' } })
        .expect(200);
      await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: client.email, password: 'Another-pass-2' })
        .expect(200);
    });
  });

  it('GET /api/health is public', async () => {
    await ctx.http().get('/api/health').expect(200, { status: 'ok', db: 'ok' });
  });

  it('unknown routes return the contract error shape', async () => {
    const res = await ctx.http().get('/api/definitely-not-here').expect(404);
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
  });
});
