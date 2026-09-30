import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ApiExceptionFilter } from './api-exception.filter';
import { DomainError } from './domain-error';

function run(exception: unknown) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = { switchToHttp: () => ({ getResponse: () => res }) };
  new ApiExceptionFilter().catch(exception, host as never);
  return { status: res.status.mock.calls[0][0] as number, body: res.json.mock.calls[0][0] };
}

describe('ApiExceptionFilter', () => {
  it.each([
    [new DomainError('NO_PACKAGE'), 402, 'NO_PACKAGE'],
    [new DomainError('SLOT_TAKEN'), 409, 'SLOT_TAKEN'],
    [new DomainError('CANCEL_CUTOFF'), 403, 'CANCEL_CUTOFF'],
    [new DomainError('LINK_REVOKED'), 410, 'LINK_REVOKED'],
    [new DomainError('BOOKING_CUTOFF'), 422, 'BOOKING_CUTOFF'],
    [new ThrottlerException(), 429, 'RATE_LIMITED'],
    [new ForbiddenException(), 403, 'FORBIDDEN'],
    [new NotFoundException('Cannot GET /x'), 404, 'NOT_FOUND'],
  ])('maps %s to %i %s', (exception, status, code) => {
    const out = run(exception);
    expect(out.status).toBe(status);
    expect(out.body.code).toBe(code);
    expect(typeof out.body.message).toBe('string');
  });

  it('hides internals of unexpected errors', () => {
    Logger.overrideLogger(false);
    const out = run(new Error('db password is hunter2'));
    expect(out).toEqual({
      status: 500,
      body: { code: 'INTERNAL', message: expect.not.stringContaining('hunter2') },
    });
  });
});
