/**
 * Dev seed (SPEC §9 Prompt 0): 2 trainers, 4 clients, 2 weeks of slots incl. one repeating series,
 * package type "10 practices / month", one package per client (one unpaid, one extended), 12 exercises,
 * Plan A + Plan B templates. Re-runnable: it wipes and rebuilds the dev database. Refuses in production.
 *
 *   pnpm db:seed          (reads the backend .env)
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from 'dotenv';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/common/crypto/password';
import { deriveToken, sha256 } from '../src/common/crypto/tokens';
import { PrismaClient, type SessionStatus } from '../src/generated/prisma/client';

config({ path: ['.env', '../../.env'], quiet: true });

const env = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
};
if (process.env.NODE_ENV === 'production')
  throw new Error('Refusing to seed a production database');

const ZONE = process.env.APP_TIMEZONE ?? 'Europe/Belgrade';
const APP_URL = env('APP_URL').replace(/\/$/, '');
const JOIN_SECRET = env('JOIN_TOKEN_SECRET');
export const SEED_PASSWORD = 'Sila-dev-2026!';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env('DATABASE_URL') }),
});

const EXERCISES: Array<[string, string, string]> = [
  ['Back squat', 'Legs', 'Bar on upper back, sit between the hips, knees track toes.'],
  ['Romanian deadlift', 'Legs', 'Soft knees, hinge at the hips, bar close to the legs.'],
  ['Walking lunge', 'Legs', 'Long step, back knee just above the floor.'],
  ['Bench press', 'Push', 'Shoulder blades pinned, bar to lower chest.'],
  ['Overhead press', 'Push', 'Glutes tight, press straight up, head through.'],
  ['Push-up', 'Push', 'Rigid plank, chest to the floor.'],
  ['Pull-up', 'Pull', 'Full hang to chin over bar; band if needed.'],
  ['Seated cable row', 'Pull', 'Tall chest, pull to the belly button.'],
  ['Face pull', 'Pull', 'Rope to the forehead, elbows high.'],
  ['Plank', 'Core', 'Straight line head to heels, breathe.'],
  ['Dead bug', 'Core', 'Low back pressed down, slow opposite arm/leg.'],
  ['Farmer carry', 'Conditioning', 'Heavy, tall posture, short steps.'],
];
// Plan A / Plan B templates as indexes into EXERCISES
const PLAN_A = [0, 1, 3, 5, 9];
const PLAN_B = [2, 6, 7, 8, 10, 11];

const day = (dt: DateTime) => new Date(`${dt.toISODate()}T00:00:00.000Z`);

async function wipe() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
}

async function createUser(
  role: 'TRAINER' | 'CLIENT',
  email: string,
  firstName: string,
  lastName: string,
  phone: string | null,
  passwordHash: string,
) {
  return prisma.user.create({
    data: { role, email, firstName, lastName, phone, passwordHash, consentAt: new Date() },
  });
}

async function createJoinLink(trainerId: string, revoked = false): Promise<string> {
  const id = randomUUID();
  const token = deriveToken(JOIN_SECRET, 'join', id);
  await prisma.joinLink.create({
    data: { id, trainerId, tokenHash: sha256(token), revokedAt: revoked ? new Date() : null },
  });
  return `${APP_URL}/join/${token}`;
}

async function main() {
  await wipe();
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const now = DateTime.now().setZone(ZONE);
  const today = now.startOf('day');
  const weekStart = today.startOf('week'); // Monday (ISO)

  // ------------------------------------------------------------------ people
  const marko = await createUser(
    'TRAINER',
    'trainer1@sila.test',
    'Marko',
    'Ilić',
    '+381 64 123 4567',
    passwordHash,
  );
  const jovana = await createUser(
    'TRAINER',
    'trainer2@sila.test',
    'Jovana',
    'Stojanović',
    '+381 64 765 4321',
    passwordHash,
  );
  const ana = await createUser(
    'CLIENT',
    'ana@sila.test',
    'Ana',
    'Petrović',
    '+381 63 111 2222',
    passwordHash,
  );
  const luka = await createUser(
    'CLIENT',
    'luka@sila.test',
    'Luka',
    'Jovanović',
    '+381 65 333 4444',
    passwordHash,
  );
  const jelena = await createUser(
    'CLIENT',
    'jelena@sila.test',
    'Jelena',
    'Nikolić',
    null,
    passwordHash,
  );
  const stefan = await createUser(
    'CLIENT',
    'stefan@sila.test',
    'Stefan',
    'Marković',
    '+381 60 555 6666',
    passwordHash,
  );
  const roster = [
    { trainer: marko, clients: [ana, luka] },
    { trainer: jovana, clients: [jelena, stefan] },
  ];
  for (const { trainer, clients } of roster) {
    for (const c of clients) {
      await prisma.trainerClient.create({
        data: {
          trainerId: trainer.id,
          clientId: c.id,
          joinedAt: today.minus({ days: 40 }).toJSDate(),
        },
      });
    }
  }

  // ------------------------------------------------------------------ catalog, library, templates
  const types = new Map<string, string>();
  const exerciseIds = new Map<string, string[]>();
  const templates = new Map<string, { a: string; b: string }>();
  for (const { trainer } of roster) {
    const type = await prisma.packageType.create({
      data: {
        trainerId: trainer.id,
        name: '10 practices / month',
        practices: 10,
        validityMonths: 1,
        priceRsd: 24000,
      },
    });
    types.set(trainer.id, type.id);

    const ids: string[] = [];
    for (const [name, category, description] of EXERCISES) {
      ids.push(
        (
          await prisma.exercise.create({
            data: { trainerId: trainer.id, name, category, description },
          })
        ).id,
      );
    }
    exerciseIds.set(trainer.id, ids);

    const mkPlan = async (
      name: string,
      sortOrder: number,
      idx: number[],
      clientId: string | null,
      notes: string,
    ) =>
      prisma.plan.create({
        data: {
          trainerId: trainer.id,
          clientId,
          name,
          sortOrder,
          notes,
          exercises: {
            create: idx.map((e, i) => ({
              exerciseId: ids[e]!,
              sets: 3,
              reps: '8-10',
              restSec: 90,
              sortOrder: i,
            })),
          },
        },
      });
    const a = await mkPlan('Plan A', 0, PLAN_A, null, 'Lower body + push');
    const b = await mkPlan('Plan B', 1, PLAN_B, null, 'Hinge + pull');
    templates.set(trainer.id, { a: a.id, b: b.id });
  }

  // client copies of Plan A / Plan B (what "assign template" produces)
  const clientPlans = new Map<string, string[]>();
  for (const { trainer, clients } of roster) {
    const ids = exerciseIds.get(trainer.id)!;
    for (const c of clients) {
      const planIds: string[] = [];
      for (const [name, sortOrder, idx, notes] of [
        ['Plan A', 0, PLAN_A, 'Lower body + push'],
        ['Plan B', 1, PLAN_B, 'Hinge + pull'],
      ] as const) {
        const p = await prisma.plan.create({
          data: {
            trainerId: trainer.id,
            clientId: c.id,
            name,
            sortOrder,
            notes,
            exercises: {
              create: idx.map((e, i) => ({
                exerciseId: ids[e]!,
                sets: 3,
                reps: '8-10',
                restSec: 90,
                sortOrder: i,
              })),
            },
          },
        });
        planIds.push(p.id);
      }
      clientPlans.set(c.id, planIds);
    }
  }

  // ------------------------------------------------------------------ packages (one per client)
  const pkg = async (
    trainerId: string,
    clientId: string,
    validFrom: DateTime,
    opts: { unpaid?: boolean; extended?: boolean } = {},
  ) => {
    const validUntil = validFrom.plus({ months: 1 }).minus({ days: 1 });
    return prisma.package.create({
      data: {
        trainerId,
        clientId,
        packageTypeId: types.get(trainerId)!,
        name: '10 practices / month',
        totalPractices: 10,
        validFrom: day(validFrom),
        validUntil: day(validUntil),
        extendedUntil: opts.extended ? day(validFrom.plus({ weeks: 5 }).minus({ days: 1 })) : null,
        extensionNote: opts.extended ? 'Away on a business trip for a week — approved.' : null,
        extensionApprovedAt: opts.extended ? today.minus({ days: 3 }).toJSDate() : null,
        priceRsd: 24000,
        paymentStatus: opts.unpaid ? 'UNPAID' : 'PAID',
        paymentMethod: opts.unpaid ? null : 'CASH',
        paidAt: opts.unpaid ? null : validFrom.toJSDate(),
      },
    });
  };
  const packages = new Map<string, string>();
  packages.set(ana.id, (await pkg(marko.id, ana.id, today.minus({ days: 8 }))).id);
  packages.set(
    luka.id,
    (await pkg(marko.id, luka.id, today.minus({ days: 12 }), { unpaid: true })).id,
  );
  // started 30 days ago: the regular month is (nearly) over, the 5-week extension keeps it active
  packages.set(
    jelena.id,
    (await pkg(jovana.id, jelena.id, today.minus({ days: 30 }), { extended: true })).id,
  );
  packages.set(stefan.id, (await pkg(jovana.id, stefan.id, today.minus({ days: 3 }))).id);

  // ------------------------------------------------------------------ slots: 2 weeks from this Monday
  const slot = (
    trainerId: string,
    start: DateTime,
    extra: {
      status?: 'OPEN' | 'LOCKED';
      lockReason?: string;
      reservedForClientId?: string;
      seriesId?: string;
    } = {},
  ) =>
    prisma.slot.create({
      data: {
        trainerId,
        startsAt: start.toJSDate(),
        endsAt: start.plus({ minutes: 60 }).toJSDate(),
        status: extra.status ?? 'OPEN',
        lockReason: extra.lockReason ?? null,
        reservedForClientId: extra.reservedForClientId ?? null,
        seriesId: extra.seriesId ?? null,
      },
    });

  // Marko: repeating series Mon + Wed 18:00 reserved for Luka with auto-book
  const series = await prisma.slotSeries.create({
    data: {
      trainerId: marko.id,
      weekdays: [1, 3],
      startTime: '18:00',
      validFrom: day(weekStart),
      reservedForClientId: luka.id,
      autoBook: true,
    },
  });

  type SlotRow = Awaited<ReturnType<typeof slot>>;
  const markoSlots: SlotRow[] = [];
  const seriesSlots: SlotRow[] = [];
  const jovanaSlots: SlotRow[] = [];
  for (let d = 0; d < 14; d++) {
    const date = weekStart.plus({ days: d });
    if (date.weekday > 5) continue; // Mon–Fri
    for (const hour of [8, 9, 10, 16, 17]) {
      const start = date.set({ hour, minute: 0 });
      const isBreak = hour === 10 && date.weekday === 3; // Wednesday 10:00 break
      markoSlots.push(
        await slot(marko.id, start, isBreak ? { status: 'LOCKED', lockReason: 'Break' } : {}),
      );
    }
    if (date.weekday === 1 || date.weekday === 3) {
      seriesSlots.push(
        await slot(marko.id, date.set({ hour: 18, minute: 0 }), {
          reservedForClientId: luka.id,
          seriesId: series.id,
        }),
      );
    }
    if (date.weekday === 5) {
      // a single slot reserved for Ana (Friday 07:00)
      markoSlots.push(
        await slot(marko.id, date.set({ hour: 7, minute: 0 }), { reservedForClientId: ana.id }),
      );
    }
    // Jovana works half-hours to exercise the :30 rule
    for (const [hour, minute] of [
      [9, 30],
      [11, 0],
      [17, 30],
    ] as const) {
      jovanaSlots.push(await slot(jovana.id, date.set({ hour, minute })));
    }
  }

  // ------------------------------------------------------------------ practices
  const nowJs = now.toJSDate();
  const book = async (
    s: SlotRow,
    trainerId: string,
    clientId: string,
    status: SessionStatus,
    planIdx: number,
    createdById: string,
  ) =>
    prisma.session.create({
      data: {
        slotId: s.id,
        trainerId,
        clientId,
        packageId: packages.get(clientId)!,
        planId: clientPlans.get(clientId)![planIdx] ?? null,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status,
        createdById,
        attendanceMarkedAt: status === 'BOOKED' ? null : s.endsAt,
      },
    });
  const openSlots = (list: SlotRow[]) =>
    list.filter((s) => s.status === 'OPEN' && !s.reservedForClientId);
  const past = openSlots(markoSlots).filter((s) => s.endsAt < nowJs);
  const future = openSlots(markoSlots).filter(
    (s) => s.startsAt.getTime() - nowJs.getTime() > 24 * 3_600_000,
  );

  // past: Ana came (Plan A), Luka didn't come (Plan B) — only when this week already has past slots
  if (past[0]) await book(past[0], marko.id, ana.id, 'ATTENDED', 0, ana.id);
  if (past[1]) await book(past[1], marko.id, luka.id, 'NO_SHOW', 1, marko.id);
  // today: a practice for the Today screen if there's still time today
  const laterToday = openSlots(markoSlots).find(
    (s) => s.startsAt > nowJs && DateTime.fromJSDate(s.startsAt).setZone(ZONE).hasSame(now, 'day'),
  );
  if (laterToday) await book(laterToday, marko.id, ana.id, 'BOOKED', 1, ana.id);
  // upcoming: Ana books ahead, Luka's reserved series slots are auto-booked
  if (future[2]) await book(future[2], marko.id, ana.id, 'BOOKED', 0, ana.id);
  for (const s of seriesSlots.filter((x) => x.startsAt > nowJs).slice(0, 2)) {
    await book(s, marko.id, luka.id, 'BOOKED', 0, marko.id);
  }
  const jFuture = jovanaSlots.filter(
    (s) => s.startsAt.getTime() - nowJs.getTime() > 24 * 3_600_000,
  );
  if (jFuture[0]) await book(jFuture[0], jovana.id, stefan.id, 'BOOKED', 0, stefan.id);
  if (jFuture[3]) await book(jFuture[3], jovana.id, jelena.id, 'BOOKED', 1, jelena.id);

  // ------------------------------------------------------------------ notes
  await prisma.clientNote.createMany({
    data: [
      { trainerId: marko.id, clientId: ana.id, body: 'Left knee — no deep lunges.', pinned: true },
      { trainerId: marko.id, clientId: ana.id, body: 'Goal: first pull-up by December.' },
      {
        trainerId: marko.id,
        clientId: luka.id,
        body: 'Pays by transfer at the start of the month.',
        pinned: true,
      },
      {
        trainerId: jovana.id,
        clientId: jelena.id,
        body: 'Post-rehab shoulder: no overhead pressing yet.',
        pinned: true,
      },
    ],
  });

  // ------------------------------------------------------------------ join links
  await createJoinLink(marko.id, true); // an old, revoked link (410)
  const markoUrl = await createJoinLink(marko.id);
  const jovanaUrl = await createJoinLink(jovana.id);

  const counts = {
    users: await prisma.user.count(),
    slots: await prisma.slot.count(),
    sessions: await prisma.session.count(),
    exercises: await prisma.exercise.count(),
    plans: await prisma.plan.count(),
  };
  console.log(`
Seeded SILA dev data  ${JSON.stringify(counts)}
  Password for every account: ${SEED_PASSWORD}
  Trainers: trainer1@sila.test (Marko Ilić) · trainer2@sila.test (Jovana Stojanović)
  Clients:  ana@ (paid) · luka@ (UNPAID, Mon/Wed 18:00 series) → Marko
            jelena@ (extended) · stefan@ → Jovana          (all @sila.test)
  Join links:
    Marko:  ${markoUrl}
    Jovana: ${jovanaUrl}
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
