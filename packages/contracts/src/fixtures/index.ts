/**
 * Realistic fixtures for MSW mocks and tests. Every value is validated against the contract schemas in
 * `fixtures.spec.ts`, so mocks can never drift from the API shapes.
 *
 * Times are generated relative to `now` so mocked screens always look "live". Times are whole UTC hours,
 * which are always :00 in Europe/Belgrade too.
 */
import type { AuthResponse, Me } from '../schemas/auth';
import type { ClientHome, ClientPractice, ClientSlot } from '../schemas/client';
import type { ClientDetail, ClientFlag, ClientListItem } from '../schemas/clients';
import type { PersonSummary, PlanRef } from '../schemas/common';
import type { Document, Exercise, Note, Plan } from '../schemas/content';
import type { JoinInfo, JoinLinkResponse } from '../schemas/join';
import type { Package, PackageType } from '../schemas/packages';
import type {
  SlotSeries,
  TodayPractice,
  TrainerPractice,
  TrainerSlot,
} from '../schemas/scheduling';

/** Deterministic, valid v4-shaped UUIDs: fid(1) → 00000000-0000-4000-8000-000000000001 */
export const fid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export const FIXTURE_JOIN_TOKEN = 'mock-join-token-marko-7Q2K9xYzAbCdEfGh';
export const FIXTURE_REVOKED_TOKEN = 'mock-revoked-token-000000000000000000';
export const FIXTURE_PASSWORD = 'Sila-dev-2026!';

const iso = (d: Date) => d.toISOString();
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const addHours = (d: Date, n: number) => new Date(d.getTime() + n * 3_600_000);
/** Today at a given UTC hour. */
const at = (base: Date, dayOffset: number, utcHour: number) => {
  const d = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), utcHour),
  );
  return addDays(d, dayOffset);
};

export interface Fixtures {
  now: Date;
  trainer: Me;
  trainerSummary: PersonSummary;
  clients: ClientDetail[];
  clientMe: Me;
  auth: { trainer: AuthResponse; client: AuthResponse };
  joinInfo: JoinInfo;
  joinLink: JoinLinkResponse;
  packageTypes: PackageType[];
  packages: Package[];
  exercises: Exercise[];
  templates: Plan[];
  clientPlans: Plan[];
  notes: Note[];
  documents: Document[];
  series: SlotSeries[];
  slots: TrainerSlot[];
  practices: TrainerPractice[];
  today: TodayPractice[];
  clientHome: ClientHome;
  clientSlots: ClientSlot[];
  clientUpcoming: ClientPractice[];
  clientPast: ClientPractice[];
}

const QR_PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h29v29H0z"/><path stroke="#0f1729" d="M2 2.5h7m1 0h1m2 0h3m4 0h7M2 3.5h1m5 0h1m2 0h2m1 0h1m3 0h1m1 0h1m5 0h1M2 4.5h1m1 0h3m1 0h1m1 0h3m1 0h2m2 0h1m1 0h1m1 0h3m1 0h1M2 5.5h1m1 0h3m1 0h1m3 0h1m2 0h1m3 0h1m1 0h3m1 0h1M2 6.5h1m1 0h3m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m2 0h1m1 0h3m1 0h1M2 7.5h1m5 0h1m1 0h2m3 0h1m2 0h1m5 0h1M2 8.5h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7"/></svg>';

export function buildFixtures(now: Date = new Date()): Fixtures {
  const createdAt = iso(addDays(now, -40));

  // ---------------------------------------------------------------- people
  const trainerSummary: PersonSummary = {
    id: fid(1),
    firstName: 'Marko',
    lastName: 'Ilić',
    photoUrl: null,
  };
  const trainer: Me = {
    ...trainerSummary,
    role: 'TRAINER',
    email: 'trainer1@sila.test',
    phone: '+381 64 123 4567',
    consentAt: createdAt,
    trainer: null,
  };

  const people: Array<PersonSummary & { email: string; phone: string | null }> = [
    {
      id: fid(11),
      firstName: 'Ana',
      lastName: 'Petrović',
      photoUrl: null,
      email: 'ana@sila.test',
      phone: '+381 63 111 2222',
    },
    {
      id: fid(12),
      firstName: 'Luka',
      lastName: 'Jovanović',
      photoUrl: null,
      email: 'luka@sila.test',
      phone: '+381 65 333 4444',
    },
    {
      id: fid(13),
      firstName: 'Jelena',
      lastName: 'Nikolić',
      photoUrl: null,
      email: 'jelena@sila.test',
      phone: null,
    },
    {
      id: fid(14),
      firstName: 'Stefan',
      lastName: 'Marković',
      photoUrl: null,
      email: 'stefan@sila.test',
      phone: '+381 60 555 6666',
    },
  ];
  const summary = (p: PersonSummary): PersonSummary => ({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    photoUrl: p.photoUrl,
  });
  const [ana, luka, jelena, stefan] = people as [
    (typeof people)[0],
    (typeof people)[0],
    (typeof people)[0],
    (typeof people)[0],
  ];

  const clientMe: Me = {
    ...summary(ana),
    role: 'CLIENT',
    email: ana.email,
    phone: ana.phone,
    consentAt: createdAt,
    trainer: trainerSummary,
  };

  // ---------------------------------------------------------------- catalog + packages
  const packageTypes: PackageType[] = [
    {
      id: fid(101),
      name: '10 practices / month',
      practices: 10,
      validityMonths: 1,
      priceRsd: 24000,
      archivedAt: null,
    },
    {
      id: fid(102),
      name: '8 practices / month',
      practices: 8,
      validityMonths: 1,
      priceRsd: 20000,
      archivedAt: null,
    },
  ];

  const pkg = (
    n: number,
    clientId: string,
    startOffsetDays: number,
    used: number,
    opts: Partial<Package> = {},
  ): Package => {
    const validFrom = addDays(now, startOffsetDays);
    const validUntil = addDays(validFrom, 29);
    const extendedUntil = opts.extendedUntil ?? null;
    const available = 10 + (opts.adjustment ?? 0);
    const left = available - used;
    const effectiveUntil = extendedUntil ?? day(validUntil);
    return {
      id: fid(n),
      clientId,
      packageTypeId: packageTypes[0]!.id,
      name: '10 practices / month',
      totalPractices: 10,
      adjustment: 0,
      validFrom: day(validFrom),
      validUntil: day(validUntil),
      extendedUntil,
      extensionNote: null,
      extensionApprovedAt: null,
      priceRsd: 24000,
      paymentStatus: 'PAID',
      paymentMethod: 'CASH',
      paidAt: iso(validFrom),
      paymentNote: null,
      createdAt: iso(validFrom),
      ...opts,
      usage: { available, used, left, effectiveUntil },
      isActive: left > 0 && effectiveUntil >= day(now) && day(validFrom) <= day(now),
    };
  };

  const packages: Package[] = [
    // Ana: paid, 7 of 10 left
    pkg(201, ana.id, -8, 3),
    // Luka: UNPAID, 5 left
    pkg(202, luka.id, -12, 5, { paymentStatus: 'UNPAID', paymentMethod: null, paidAt: null }),
    // Jelena: extended to 5 weeks, 2 left, expiring soon
    pkg(203, jelena.id, -31, 8, {
      extendedUntil: day(addDays(now, 3)),
      extensionNote: 'Away for a week, approved.',
      extensionApprovedAt: iso(addDays(now, -5)),
    }),
    // Stefan: no active package (expired)
    pkg(204, stefan.id, -45, 10),
  ];

  // ---------------------------------------------------------------- library + plans
  const exerciseNames: Array<[string, string]> = [
    ['Back squat', 'Legs'],
    ['Romanian deadlift', 'Legs'],
    ['Walking lunge', 'Legs'],
    ['Bench press', 'Push'],
    ['Overhead press', 'Push'],
    ['Push-up', 'Push'],
    ['Pull-up', 'Pull'],
    ['Seated cable row', 'Pull'],
    ['Face pull', 'Pull'],
    ['Plank', 'Core'],
    ['Dead bug', 'Core'],
    ['Farmer carry', 'Conditioning'],
  ];
  const exercises: Exercise[] = exerciseNames.map(([name, category], i) => ({
    id: fid(301 + i),
    name,
    category,
    description: null,
    videoUrl: null,
    archivedAt: null,
  }));
  const ex = (i: number) => {
    const e = exercises[i]!;
    return { id: e.id, name: e.name, category: e.category, videoUrl: e.videoUrl };
  };
  const planExercises = (base: number, idx: number[]) =>
    idx.map((e, sortOrder) => ({
      id: fid(base + sortOrder),
      exercise: ex(e),
      sets: 3,
      reps: '8-10',
      weight: null,
      restSec: 90,
      notes: null,
      sortOrder,
    }));

  const templates: Plan[] = [
    {
      id: fid(401),
      clientId: null,
      name: 'Plan A',
      notes: 'Lower body + push',
      sortOrder: 0,
      archivedAt: null,
      exercises: planExercises(4101, [0, 1, 3, 5, 9]),
    },
    {
      id: fid(402),
      clientId: null,
      name: 'Plan B',
      notes: 'Hinge + pull',
      sortOrder: 1,
      archivedAt: null,
      exercises: planExercises(4201, [2, 6, 7, 8, 10, 11]),
    },
  ];
  const clientPlans: Plan[] = people.flatMap((p, i) =>
    templates.map((t, j) => ({
      ...t,
      id: fid(500 + i * 10 + j),
      clientId: p.id,
      exercises: t.exercises.map((e, k) => ({ ...e, id: fid(5000 + i * 100 + j * 20 + k) })),
    })),
  );
  const planRefsFor = (clientId: string): PlanRef[] =>
    clientPlans.filter((p) => p.clientId === clientId).map((p) => ({ id: p.id, name: p.name }));

  // ---------------------------------------------------------------- notes + documents
  const notes: Note[] = [
    {
      id: fid(601),
      clientId: ana.id,
      body: 'Left knee — no deep lunges.',
      pinned: true,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: fid(602),
      clientId: ana.id,
      body: 'Goal: first pull-up by December.',
      pinned: false,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: fid(603),
      clientId: luka.id,
      body: 'Pays by transfer at the start of the month.',
      pinned: true,
      createdAt,
      updatedAt: createdAt,
    },
  ];
  const documents: Document[] = [
    {
      id: fid(701),
      clientId: ana.id,
      fileName: 'knee-mri-report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 482_113,
      confirmedAt: createdAt,
      createdAt,
    },
  ];

  // ---------------------------------------------------------------- slots + practices
  const series: SlotSeries[] = [
    {
      id: fid(801),
      weekdays: [1, 3],
      startTime: '18:00',
      validFrom: day(addDays(now, -14)),
      validUntil: null,
      reservedFor: summary(luka),
      autoBook: true,
      createdAt,
    },
  ];

  const clientById = new Map(people.map((p) => [p.id, p]));
  const practices: TrainerPractice[] = [];
  const slots: TrainerSlot[] = [];
  let slotN = 900;
  let practiceN = 1000;

  const addSlot = (
    startsAt: Date,
    opts: {
      clientId?: string;
      status?: TrainerPractice['status'];
      locked?: string;
      reservedFor?: string;
      planIdx?: number;
      parallel?: boolean;
    } = {},
  ) => {
    const slotId = fid(++slotN);
    let practice: TrainerSlot['practice'] = null;
    if (opts.clientId) {
      const client = summary(clientById.get(opts.clientId)!);
      const plans = planRefsFor(opts.clientId);
      const p: TrainerPractice = {
        id: fid(++practiceN),
        slotId,
        startsAt: iso(startsAt),
        endsAt: iso(addHours(startsAt, 1)),
        status: opts.status ?? 'BOOKED',
        client,
        packageId: packages.find((x) => x.clientId === opts.clientId)?.id ?? null,
        plan: plans[opts.planIdx ?? 0] ?? null,
        practiceReturned: false,
        cancelledAt: null,
        attendanceMarkedAt:
          opts.status && opts.status !== 'BOOKED' ? iso(addHours(startsAt, 1)) : null,
        createdAt,
      };
      practices.push(p);
      practice = { id: p.id, status: p.status, client };
    }
    slots.push({
      id: slotId,
      startsAt: iso(startsAt),
      endsAt: iso(addHours(startsAt, 1)),
      status: opts.locked ? 'LOCKED' : 'OPEN',
      lockReason: opts.locked ?? null,
      reservedFor: opts.reservedFor ? summary(clientById.get(opts.reservedFor)!) : null,
      seriesId: null,
      parallel: opts.parallel ?? false,
      practice,
    });
  };

  // yesterday (past, attended / no-show), today, and the next 7 days
  addSlot(at(now, -1, 7), { clientId: ana.id, status: 'ATTENDED', planIdx: 0 });
  addSlot(at(now, -1, 9), { clientId: luka.id, status: 'NO_SHOW', planIdx: 1 });
  addSlot(at(now, 0, 6), { clientId: ana.id, planIdx: 1 });
  addSlot(at(now, 0, 8), { clientId: jelena.id, planIdx: 0 });
  addSlot(at(now, 0, 10), { locked: 'Break' });
  addSlot(at(now, 0, 14), { clientId: luka.id, planIdx: 0 });
  addSlot(at(now, 0, 16));
  for (let d = 1; d <= 7; d++) {
    addSlot(at(now, d, 7), d === 2 ? { clientId: ana.id, planIdx: 0 } : {});
    addSlot(at(now, d, 8));
    addSlot(at(now, d, 9), d === 3 ? { locked: 'Personal' } : {});
    addSlot(at(now, d, 15), d === 1 ? { reservedFor: luka.id } : {});
    addSlot(at(now, d, 16), d === 4 ? { clientId: jelena.id, planIdx: 1 } : {});
  }

  const packageBadge = (clientId: string) => {
    const p = packages.find((x) => x.clientId === clientId && x.isActive);
    return p
      ? {
          packageId: p.id,
          name: p.name,
          left: p.usage.left,
          total: p.totalPractices,
          paymentStatus: p.paymentStatus,
        }
      : null;
  };
  const pinned = (clientId: string) => {
    const n = notes.find((x) => x.clientId === clientId && x.pinned);
    return n ? { id: n.id, body: n.body } : null;
  };

  const todayKey = day(now);
  const today: TodayPractice[] = practices
    .filter((p) => p.startsAt.slice(0, 10) === todayKey)
    .map((p) => ({
      ...p,
      pinnedNote: pinned(p.client.id),
      package: packageBadge(p.client.id),
      clientPlans: planRefsFor(p.client.id),
    }));

  // ---------------------------------------------------------------- client list
  const flagsFor = (clientId: string): ClientFlag[] => {
    const active = packages.find((x) => x.clientId === clientId && x.isActive);
    if (!active) return ['NO_PACKAGE'];
    const flags: ClientFlag[] = [];
    if (active.paymentStatus === 'UNPAID') flags.push('UNPAID');
    if (active.usage.left <= 2) flags.push('LOW');
    if (active.usage.effectiveUntil <= day(addDays(now, 5))) flags.push('EXPIRING');
    return flags;
  };
  const nextPracticeFor = (clientId: string) => {
    const next = practices
      .filter((p) => p.client.id === clientId && p.status === 'BOOKED' && p.startsAt > iso(now))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
    return next ? { id: next.id, startsAt: next.startsAt } : null;
  };
  const clients: ClientDetail[] = people.map((p) => {
    const item: ClientListItem = {
      ...summary(p),
      phone: p.phone,
      joinedAt: createdAt,
      archived: false,
      activePackage: packages.find((x) => x.clientId === p.id && x.isActive) ?? null,
      nextPractice: nextPracticeFor(p.id),
      flags: flagsFor(p.id),
    };
    return { ...item, email: p.email, consentAt: createdAt, pinnedNote: pinned(p.id) };
  });

  // ---------------------------------------------------------------- client (Ana) views
  const anaPkg = packages[0]!;
  const toClientPractice = (p: TrainerPractice): ClientPractice => ({
    id: p.id,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    status: p.status,
    canCancel: p.status === 'BOOKED' && Date.parse(p.startsAt) - now.getTime() >= 6 * 3_600_000,
    cancelledAt: p.cancelledAt,
    packageName: anaPkg.name,
  });
  const anaPractices = practices.filter((p) => p.client.id === ana.id);
  const clientUpcoming = anaPractices
    .filter((p) => p.startsAt > iso(now) && p.status === 'BOOKED')
    .map(toClientPractice);
  const clientPast = anaPractices.filter((p) => p.startsAt <= iso(now)).map(toClientPractice);

  const clientSlots: ClientSlot[] = slots
    .filter(
      (s) =>
        s.status === 'OPEN' &&
        !s.practice &&
        (!s.reservedFor || s.reservedFor.id === ana.id) &&
        Date.parse(s.startsAt) - now.getTime() >= 6 * 3_600_000,
    )
    .map((s) => ({
      id: s.id,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      withinPackage: s.startsAt.slice(0, 10) <= anaPkg.usage.effectiveUntil,
      reservedForMe: s.reservedFor?.id === ana.id,
    }));

  const clientHome: ClientHome = {
    hasActivePackage: true,
    left: anaPkg.usage.left,
    total: anaPkg.totalPractices,
    validUntil: anaPkg.usage.effectiveUntil,
    extended: anaPkg.extendedUntil !== null,
    packageName: anaPkg.name,
    nextPractice: clientUpcoming[0] ?? null,
    trainer: trainerSummary,
  };

  const auth = {
    trainer: { accessToken: 'mock-access-token-trainer', expiresIn: 900, user: trainer },
    client: { accessToken: 'mock-access-token-client', expiresIn: 900, user: clientMe },
  };

  return {
    now,
    trainer,
    trainerSummary,
    clients,
    clientMe,
    auth,
    joinInfo: { trainerName: 'Marko Ilić', trainerFirstName: 'Marko', trainerPhotoUrl: null },
    joinLink: {
      url: `http://localhost:3001/join/${FIXTURE_JOIN_TOKEN}`,
      qrSvg: QR_PLACEHOLDER_SVG,
      createdAt,
    },
    packageTypes,
    packages,
    exercises,
    templates,
    clientPlans,
    notes,
    documents,
    series,
    slots,
    practices,
    today,
    clientHome,
    clientSlots,
    clientUpcoming,
    clientPast,
  };
}
