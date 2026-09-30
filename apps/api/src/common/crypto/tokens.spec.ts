import { deriveToken, hmacHex, randomToken, safeEqual, sha256 } from './tokens';

describe('tokens', () => {
  it('randomToken is 32 bytes of base64url', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });

  it('deriveToken is deterministic per (secret, purpose, id) and 32 bytes', () => {
    const a = deriveToken('secret', 'join', 'id-1');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveToken('secret', 'join', 'id-1')).toBe(a);
    expect(deriveToken('secret', 'join', 'id-2')).not.toBe(a);
    expect(deriveToken('secret', 'calendar', 'id-1')).not.toBe(a);
    expect(deriveToken('other', 'join', 'id-1')).not.toBe(a);
  });

  it('hashes', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hmacHex('k', 'v')).toHaveLength(64);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
