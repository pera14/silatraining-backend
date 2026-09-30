import { nextPlanId } from './plan-rotation';

describe('nextPlanId', () => {
  const plans = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];

  it('returns null when the client has no plans', () => {
    expect(nextPlanId([], null)).toBeNull();
    expect(nextPlanId([], 'A')).toBeNull();
  });

  it('starts with the first plan without history', () => {
    expect(nextPlanId(plans, null)).toBe('A');
  });

  it('advances and wraps around', () => {
    expect(nextPlanId(plans, 'A')).toBe('B');
    expect(nextPlanId(plans, 'B')).toBe('C');
    expect(nextPlanId(plans, 'C')).toBe('A');
    expect(nextPlanId([{ id: 'A' }, { id: 'B' }], 'B')).toBe('A');
  });

  it('keeps a single plan', () => {
    expect(nextPlanId([{ id: 'A' }], 'A')).toBe('A');
  });

  it('restarts when the previous plan is no longer active', () => {
    expect(nextPlanId(plans, 'archived')).toBe('A');
  });
});
