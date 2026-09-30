import { describe, expect, it } from 'vitest';
import { buildPath, buildQuery, endpoints } from './endpoints';
import { ERROR_STATUS } from './errors';

/** Every row of SPEC §5 (method + path). CRUD rows are expanded. */
const SPEC_ROWS = [
  'POST /auth/login',
  'POST /auth/refresh',
  'POST /auth/logout',
  'GET /join/:token',
  'POST /join/:token/register',
  'POST /join/:token/accept',
  'POST /auth/password/forgot',
  'POST /auth/password/reset',
  'GET /me',
  'GET /trainer/today',
  'GET /trainer/calendar',
  'POST /trainer/slots',
  'PATCH /trainer/slots/:id',
  'DELETE /trainer/slots/:id',
  'POST /trainer/slots/lock-range',
  'GET /trainer/slot-series',
  'POST /trainer/slot-series',
  'PATCH /trainer/slot-series/:id',
  'DELETE /trainer/slot-series/:id',
  'POST /trainer/sessions',
  'PATCH /trainer/sessions/:id',
  'POST /trainer/sessions/:id/move',
  'POST /trainer/sessions/:id/cancel',
  'GET /trainer/clients',
  'GET /trainer/clients/:id',
  'PATCH /trainer/clients/:id',
  'GET /trainer/join-link',
  'POST /trainer/join-link/regenerate',
  'GET /trainer/clients/:id/packages',
  'POST /trainer/clients/:id/packages',
  'PATCH /trainer/packages/:id',
  'POST /trainer/packages/:id/extend',
  'POST /trainer/packages/:id/adjust',
  'GET /trainer/package-types',
  'POST /trainer/package-types',
  'GET /trainer/package-types/:id',
  'PATCH /trainer/package-types/:id',
  'DELETE /trainer/package-types/:id',
  'GET /trainer/clients/:id/notes',
  'POST /trainer/clients/:id/notes',
  'PATCH /trainer/notes/:id',
  'DELETE /trainer/notes/:id',
  'GET /trainer/exercises',
  'POST /trainer/exercises',
  'GET /trainer/exercises/:id',
  'PATCH /trainer/exercises/:id',
  'DELETE /trainer/exercises/:id',
  'GET /trainer/plans',
  'POST /trainer/plans',
  'GET /trainer/plans/:id',
  'PATCH /trainer/plans/:id',
  'DELETE /trainer/plans/:id',
  'GET /trainer/clients/:id/plans',
  'POST /trainer/clients/:id/plans',
  'PUT /trainer/plans/:id/exercises',
  'GET /trainer/clients/:id/documents',
  'POST /trainer/clients/:id/documents',
  'POST /trainer/documents/:id/confirm',
  'GET /trainer/documents/:id/download',
  'DELETE /trainer/documents/:id',
  'GET /calendar/:token.ics',
  'GET /client/home',
  'GET /client/slots',
  'POST /client/sessions',
  'GET /client/sessions',
  'POST /client/sessions/:id/cancel',
  'GET /client/packages',
  'PATCH /client/profile',
];

describe('endpoint registry', () => {
  const registered = new Set(Object.values(endpoints).map((e) => `${e.method} ${e.path}`));

  it.each(SPEC_ROWS)('covers SPEC §5 row %s', (row) => {
    expect(registered.has(row)).toBe(true);
  });

  it('has no duplicate method+path', () => {
    expect(registered.size).toBe(Object.keys(endpoints).length);
  });

  it('only references known error codes', () => {
    for (const e of Object.values(endpoints)) {
      for (const code of e.errors) expect(ERROR_STATUS[code]).toBeDefined();
    }
  });

  it('declares params schemas for every path param', () => {
    for (const [key, e] of Object.entries(endpoints)) {
      const hasParams = /:[A-Za-z]+/.test(e.path);
      expect({ key, hasSchema: 'params' in e }).toEqual({ key, hasSchema: hasParams });
    }
  });

  it('builds paths and queries', () => {
    expect(buildPath('/trainer/slots/:id', { id: 'a b' })).toBe('/trainer/slots/a%20b');
    expect(buildPath('/calendar/:token.ics', { token: 'abc' })).toBe('/calendar/abc.ics');
    expect(() => buildPath('/x/:id')).toThrow(/Missing path param/);
    expect(buildQuery({ a: 1, b: undefined, c: 'x y' })).toBe('?a=1&c=x+y');
    expect(buildQuery({})).toBe('');
  });
});
