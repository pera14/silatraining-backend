import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildFixtures } from '.';
import { AuthResponse, Me } from '../schemas/auth';
import { ClientHome, ClientPractice, ClientSlot } from '../schemas/client';
import { ClientDetail } from '../schemas/clients';
import { Document, Exercise, Note, Plan } from '../schemas/content';
import { JoinInfo, JoinLinkResponse } from '../schemas/join';
import { Package, PackageType } from '../schemas/packages';
import { SlotSeries, TodayPractice, TrainerPractice, TrainerSlot } from '../schemas/scheduling';

describe('fixtures', () => {
  // Use several "now"s, including around DST switches, so relative-time logic can't produce invalid data.
  const nows = [new Date(), new Date('2026-03-29T00:30:00Z'), new Date('2026-10-25T23:59:00Z')];

  it.each(nows)('match the contract schemas (now=%s)', (now) => {
    const f = buildFixtures(now);
    const check = <T extends z.ZodType>(schema: T, value: unknown) =>
      expect(() => schema.parse(value)).not.toThrow();
    check(Me, f.trainer);
    check(Me, f.clientMe);
    check(AuthResponse, f.auth.trainer);
    check(AuthResponse, f.auth.client);
    check(JoinInfo, f.joinInfo);
    check(JoinLinkResponse, f.joinLink);
    check(z.array(ClientDetail), f.clients);
    check(z.array(PackageType), f.packageTypes);
    check(z.array(Package), f.packages);
    check(z.array(Exercise), f.exercises);
    check(z.array(Plan), [...f.templates, ...f.clientPlans]);
    check(z.array(Note), f.notes);
    check(z.array(Document), f.documents);
    check(z.array(SlotSeries), f.series);
    check(z.array(TrainerSlot), f.slots);
    check(z.array(TrainerPractice), f.practices);
    check(z.array(TodayPractice), f.today);
    check(ClientHome, f.clientHome);
    check(z.array(ClientSlot), f.clientSlots);
    check(z.array(ClientPractice), [...f.clientUpcoming, ...f.clientPast]);
  });

  it('covers the interesting client states', () => {
    const f = buildFixtures();
    const flags = f.clients.flatMap((c) => c.flags);
    expect(flags).toEqual(expect.arrayContaining(['UNPAID', 'NO_PACKAGE', 'LOW', 'EXPIRING']));
    expect(f.packages.some((p) => p.extendedUntil)).toBe(true);
    expect(f.exercises).toHaveLength(12);
    expect(f.today.length).toBeGreaterThan(0);
  });
});
