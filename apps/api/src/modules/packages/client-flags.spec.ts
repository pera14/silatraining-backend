import { clientFlags, type PackageFacts, pickActivePackage } from './client-flags';

const pkg = (over: Partial<PackageFacts>): PackageFacts => ({
  id: 'p',
  validFrom: '2026-10-01',
  effectiveUntil: '2026-10-31',
  left: 8,
  paymentStatus: 'PAID',
  ...over,
});

describe('pickActivePackage', () => {
  it('needs the day within validity and practices left', () => {
    expect(pickActivePackage([pkg({})], '2026-10-01')).not.toBeNull();
    expect(pickActivePackage([pkg({})], '2026-10-31')).not.toBeNull();
    expect(pickActivePackage([pkg({})], '2026-11-01')).toBeNull();
    expect(pickActivePackage([pkg({})], '2026-09-30')).toBeNull();
    expect(pickActivePackage([pkg({ left: 0 })], '2026-10-10')).toBeNull();
  });

  it('prefers the package that ends first', () => {
    const a = pkg({ id: 'a', effectiveUntil: '2026-11-04' });
    const b = pkg({ id: 'b', effectiveUntil: '2026-10-20' });
    expect(pickActivePackage([a, b], '2026-10-10')?.id).toBe('b');
  });
});

describe('clientFlags', () => {
  const today = '2026-10-10';

  it('has no flags for a healthy paid package', () => {
    expect(clientFlags([pkg({})], today)).toEqual([]);
  });

  it('flags NO_PACKAGE without an active package', () => {
    expect(clientFlags([], today)).toEqual(['NO_PACKAGE']);
    expect(clientFlags([pkg({ left: 0 })], today)).toEqual(['NO_PACKAGE']);
  });

  it('flags UNPAID for any unpaid package, expired included', () => {
    const expiredUnpaid = pkg({
      id: 'old',
      effectiveUntil: '2026-09-01',
      validFrom: '2026-08-01',
      paymentStatus: 'UNPAID',
    });
    expect(clientFlags([pkg({}), expiredUnpaid], today)).toEqual(['UNPAID']);
  });

  it('flags LOW at ≤ 2 left', () => {
    expect(clientFlags([pkg({ left: 3 })], today)).toEqual([]);
    expect(clientFlags([pkg({ left: 2 })], today)).toEqual(['LOW']);
  });

  it('flags EXPIRING at ≤ 5 days', () => {
    expect(clientFlags([pkg({ effectiveUntil: '2026-10-16' })], today)).toEqual([]);
    expect(clientFlags([pkg({ effectiveUntil: '2026-10-15' })], today)).toEqual(['EXPIRING']);
    expect(clientFlags([pkg({ effectiveUntil: '2026-10-10' })], today)).toEqual(['EXPIRING']);
  });
});
