import { createTestApp, createUser, resetDb, type TestContext } from './setup/app';

describe('rate limiting (e2e)', () => {
  let ctx: TestContext;
  const previous = process.env.AUTH_RATE_LIMIT;

  beforeAll(async () => {
    process.env.AUTH_RATE_LIMIT = '5'; // SPEC: 5/min/IP on login
    ctx = await createTestApp();
    await resetDb(ctx.prisma);
  });
  afterAll(async () => {
    process.env.AUTH_RATE_LIMIT = previous;
    await ctx?.app.close();
  });

  it('allows 5 login attempts per minute per IP, then returns 429 RATE_LIMITED', async () => {
    const user = await createUser(ctx.prisma, 'CLIENT');
    for (let i = 0; i < 5; i++) {
      await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: 'wrong-password' })
        .expect(401);
    }
    const res = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email: user.email, password: 'wrong-password' })
      .expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    // other endpoints are unaffected
    await ctx.http().get('/api/health').expect(200);
  });

  // SPEC §7: login, invite (register/accept) and password reset are all limited, per client IP. Behind Caddy the
  // client IP comes from X-Forwarded-For (trusted only from private networks, see app.setup.ts).
  it.each([
    ['/api/auth/password/forgot', { email: 'someone@mail.test' }],
    ['/api/auth/password/reset', { token: 'x'.repeat(43), password: 'New-password-1' }],
    ['/api/join/not-a-real-token/register', {}],
    ['/api/join/not-a-real-token/accept', {}],
  ])('limits %s to 5/min per client IP, independently per client', async (path, body) => {
    const from = (ip: string) => ctx.http().post(path).set('X-Forwarded-For', ip).send(body);
    for (let i = 0; i < 5; i++) expect((await from('203.0.113.7')).status).not.toBe(429);
    const limited = await from('203.0.113.7');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    // another client behind the same proxy is not affected
    expect((await from('198.51.100.20')).status).not.toBe(429);
  });

  it('sets security headers (Helmet)', async () => {
    const res = await ctx.http().get('/api/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows CORS only from APP_URL', async () => {
    const appUrl = process.env.APP_URL!;
    const ok = await ctx.http().options('/api/auth/login').set('Origin', appUrl);
    expect(ok.headers['access-control-allow-origin']).toBe(appUrl);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    // a foreign origin is never reflected: the header stays APP_URL, so the browser blocks the response
    const evil = await ctx.http().options('/api/auth/login').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBe(appUrl);
  });
});
