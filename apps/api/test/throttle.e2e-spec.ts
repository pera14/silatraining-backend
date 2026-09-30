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

  it('sets security headers (Helmet)', async () => {
    const res = await ctx.http().get('/api/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
