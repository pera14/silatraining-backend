import { SchedulerRegistry } from '@nestjs/schedule';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { NotificationsCron } from '../src/modules/notifications/notifications.cron';
import { createJoinLink, resetDb } from './setup/app';
import { createSchedulingApp, type SchedulingContext } from './scheduling/app';
import { addPackage, addSlot, clientOf, local, trainer, world } from './scheduling/fixtures';
import { mailsTo, settle, waitFor } from './content/helpers';

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('notifications (e2e)', () => {
  let ctx: SchedulingContext;
  let notifications: NotificationsService;

  beforeAll(async () => {
    ctx = await createSchedulingApp();
    notifications = ctx.app.get(NotificationsService);
    // Crons run on the wall clock; a quarter-hour tick mid-suite must not send stray reminders.
    for (const job of ctx.app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
  });
  afterAll(async () => {
    await ctx?.app.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    ctx.mailer.sent.length = 0;
    ctx.clock.set('2026-10-05T08:00:00Z'); // Mon 5 Oct 2026, 10:00 Belgrade
  });

  // ------------------------------------------------------------------ welcome

  it('welcome email to a new client after joining by link (bilingual, branded, once)', async () => {
    const t = await trainer(ctx, 'Jelena');
    const token = await createJoinLink(ctx.prisma, t.user.id);
    await ctx
      .http()
      .post(`/api/join/${token}/register`)
      .send({
        firstName: 'Mila',
        lastName: 'Jovanović',
        email: 'mila@sila.test',
        phone: '+381 64 123 4567',
        password: 'Correct-horse-9',
        consent: true,
      })
      .expect(201);

    const [mail] = await waitFor(() => {
      const m = mailsTo(ctx, 'mila@sila.test');
      expect(m).toHaveLength(1);
      return m;
    });
    expect(mail!.subject).toBe('Dobro došli u SILA Training · Welcome to SILA Training');
    expect(mail!.text).toContain('Dobro došli, Mila!');
    expect(mail!.text).toContain('Povezani ste sa trenerom Jelena Ilić.');
    expect(mail!.text.indexOf('Dobro došli')).toBeLessThan(mail!.text.indexOf('Welcome, Mila!'));
    expect(mail!.html).toContain('http://localhost:3001/brand/sila-mark.png');
    expect(mail!.html).toContain('href="http://localhost:3001/client"');

    // the same event again (e.g. a re-link) does not send twice
    await notifications.onClientJoined({
      clientId: (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'mila@sila.test' } }))
        .id,
      trainerId: t.user.id,
      via: 'accept',
    });
    expect(mailsTo(ctx, 'mila@sila.test')).toHaveLength(1);
  });

  // ------------------------------------------------------------------ booking

  it('booking confirmed: the client gets an email, whoever booked', async () => {
    const w = await world(ctx);
    const s1 = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
    const s2 = await addSlot(ctx, w.trainer.user.id, local('2026-10-08', '09:30'));
    await w.client.api.post('/client/sessions').send({ slotId: s1.id }).expect(201);
    await w.trainer.api
      .post('/trainer/sessions')
      .send({ slotId: s2.id, clientId: w.client.user.id })
      .expect(201);

    const mails = await waitFor(() => {
      const m = mailsTo(ctx, w.client.user.email);
      expect(m).toHaveLength(2);
      return m;
    });
    const byClient = mails.find((m) => m.text.includes('18:00'))!;
    expect(byClient.subject).toBe(
      'Trening je zakazan: sreda, 7. oktobar u 18:00 · Practice booked',
    );
    expect(byClient.text).toContain(
      'Vaš trening kod trenera Marko Ilić: sreda, 7. oktobar u 18:00.',
    );
    expect(byClient.text).toContain('Your practice with Marko Ilić: Wednesday 7 October at 18:00.');
    expect(byClient.text).toContain('najkasnije 6 sati pre početka');
    const byTrainer = mails.find((m) => m.text.includes('09:30'))!;
    expect(byTrainer.text).toContain(
      'Zakazan vam je trening: četvrtak, 8. oktobar u 09:30 (trener: Marko Ilić).',
    );
    expect(byTrainer.text).toContain('Your trainer Marko Ilić booked a practice for you');
    // the trainer gets nothing for bookings
    expect(mailsTo(ctx, w.trainer.user.email)).toEqual([]);
  });

  it('no email for a practice the trainer books in the past', async () => {
    const w = await world(ctx);
    const past = await addSlot(ctx, w.trainer.user.id, local('2026-10-02', '18:00'));
    await w.trainer.api
      .post('/trainer/sessions')
      .send({ slotId: past.id, clientId: w.client.user.id })
      .expect(201);
    await settle();
    expect(ctx.mailer.sent).toEqual([]);
  });

  // ------------------------------------------------------------------ cancel

  it('cancelled by the client → the trainer is emailed', async () => {
    const w = await world(ctx);
    const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
    const p = (await w.client.api.post('/client/sessions').send({ slotId: slot.id }).expect(201))
      .body;
    await w.client.api.post(`/client/sessions/${p.id}/cancel`).expect(200);

    const [mail] = await waitFor(() => {
      const m = mailsTo(ctx, w.trainer.user.email);
      expect(m).toHaveLength(1);
      return m;
    });
    expect(mail!.subject).toMatch(/^Otkazan trening: Ana Petrović-\w+, sreda, 7\. oktobar u 18:00/);
    expect(mail!.text).toContain('Trening je vraćen u paket.');
    expect(mail!.text).toContain('The practice was returned to the package.');
    expect(mail!.html).toContain(`/trainer/clients/${w.client.user.id}`);
    // the client only got the booking confirmation
    expect(mailsTo(ctx, w.client.user.email)).toHaveLength(1);
  });

  it('cancelled by the trainer → the client is emailed, with the package outcome', async () => {
    const w = await world(ctx);
    const s1 = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
    const s2 = await addSlot(ctx, w.trainer.user.id, local('2026-10-08', '18:00'));
    const s3 = await addSlot(ctx, w.trainer.user.id, local('2026-10-09', '18:00'));
    const book = async (slotId: string, withoutPackage = false) =>
      (
        await w.trainer.api
          .post('/trainer/sessions')
          .send({ slotId, clientId: w.client.user.id, withoutPackage })
          .expect(201)
      ).body.id as string;
    const p1 = await book(s1.id);
    const p2 = await book(s2.id);
    const p3 = await book(s3.id, true);
    await waitFor(() => expect(mailsTo(ctx, w.client.user.email)).toHaveLength(3));
    ctx.mailer.sent.length = 0;

    await w.trainer.api
      .post(`/trainer/sessions/${p1}/cancel`)
      .send({ returnPractice: true })
      .expect(200);
    await w.trainer.api
      .post(`/trainer/sessions/${p2}/cancel`)
      .send({ returnPractice: false })
      .expect(200);
    await w.trainer.api.post(`/trainer/sessions/${p3}/cancel`).send({}).expect(200);

    const mails = await waitFor(() => {
      const m = mailsTo(ctx, w.client.user.email);
      expect(m).toHaveLength(3);
      return m;
    });
    const on = (day: string) => mails.find((m) => m.subject.includes(day))!;
    expect(on('7. oktobar').text).toContain('Trening je vraćen u vaš paket.');
    expect(on('8. oktobar').text).toContain('Ovaj trening se računa kao iskorišćen.');
    expect(on('8. oktobar').text).toContain('This practice still counts as used.');
    expect(on('9. oktobar').text).not.toMatch(/paket|package/);
    expect(mailsTo(ctx, w.trainer.user.email)).toEqual([]);
  });

  // ------------------------------------------------------------------ move

  it('moved → the client is emailed and the reminder is re-armed for the new time', async () => {
    const w = await world(ctx);
    const from = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '09:00'));
    const to = await addSlot(ctx, w.trainer.user.id, local('2026-10-10', '11:00'));
    const p = (await w.client.api.post('/client/sessions').send({ slotId: from.id }).expect(201))
      .body;
    await waitFor(() => expect(mailsTo(ctx, w.client.user.email)).toHaveLength(1));
    // within 24h: the booking email doubles as the reminder
    expect(
      (await ctx.prisma.session.findUniqueOrThrow({ where: { id: p.id } })).reminderSentAt,
    ).not.toBeNull();

    await w.trainer.api.post(`/trainer/sessions/${p.id}/move`).send({ slotId: to.id }).expect(200);
    const mail = await waitFor(() => {
      const m = mailsTo(ctx, w.client.user.email);
      expect(m).toHaveLength(2);
      return m[1]!;
    });
    expect(mail.subject).toBe('Trening je pomeren: subota, 10. oktobar u 11:00 · Practice moved');
    expect(mail.text).toContain('(umesto: utorak, 6. oktobar u 09:00)');
    expect(mail.text).toContain(
      'New time: Saturday 10 October at 11:00 (was: Tuesday 6 October at 09:00).',
    );
    expect(
      (await ctx.prisma.session.findUniqueOrThrow({ where: { id: p.id } })).reminderSentAt,
    ).toBeNull();
  });

  // ------------------------------------------------------------------ reminders

  describe('24h reminder cron', () => {
    it('reminds each BOOKED practice once when it enters the 24h window', async () => {
      const w = await world(ctx);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00')); // Wed 16:00Z
      const p = (await w.client.api.post('/client/sessions').send({ slotId: slot.id }).expect(201))
        .body;
      await waitFor(() => expect(mailsTo(ctx, w.client.user.email)).toHaveLength(1));

      // Tue 15:59Z: 24h01m before → not yet
      expect(await notifications.sendDueReminders(new Date('2026-10-06T15:59:00Z'))).toBe(0);
      // Tue 16:00Z: exactly 24h before → reminder
      ctx.clock.set('2026-10-06T16:00:00Z');
      await ctx.app.get(NotificationsCron).reminders();
      const reminders = mailsTo(ctx, w.client.user.email).filter((m) =>
        m.subject.startsWith('Podsetnik'),
      );
      expect(reminders).toHaveLength(1);
      expect(reminders[0]!.subject).toBe(
        'Podsetnik: trening sreda, 7. oktobar u 18:00 · Practice reminder',
      );
      expect(reminders[0]!.text).toContain('otkažite u aplikaciji do sreda, 7. oktobar u 12:00');
      expect(reminders[0]!.text).toContain('cancel in the app by Wednesday 7 October at 12:00');
      expect(
        (await ctx.prisma.session.findUniqueOrThrow({ where: { id: p.id } })).reminderSentAt,
      ).toEqual(new Date('2026-10-06T16:00:00Z'));

      // later runs do nothing
      expect(await notifications.sendDueReminders(new Date('2026-10-06T16:15:00Z'))).toBe(0);
      expect(await notifications.sendDueReminders(new Date('2026-10-07T12:00:00Z'))).toBe(0);
    });

    it('skips cancelled, past, other-status and already-reminded practices; booking inside 24h is its own reminder', async () => {
      const w = await world(ctx);
      ctx.clock.set('2026-10-06T08:00:00Z');
      const soon = await addSlot(ctx, w.trainer.user.id, local('2026-10-06', '20:00')); // 10h ahead
      const cancelled = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '08:00'));
      const pSoon = (
        await w.client.api.post('/client/sessions').send({ slotId: soon.id }).expect(201)
      ).body;
      const pCancel = (
        await w.client.api.post('/client/sessions').send({ slotId: cancelled.id }).expect(201)
      ).body;
      await w.client.api.post(`/client/sessions/${pCancel.id}/cancel`).expect(200);
      await waitFor(() => expect(mailsTo(ctx, w.client.user.email)).toHaveLength(2));
      expect(
        (await ctx.prisma.session.findUniqueOrThrow({ where: { id: pSoon.id } })).reminderSentAt,
      ).not.toBeNull();

      expect(await notifications.sendDueReminders(new Date('2026-10-06T08:15:00Z'))).toBe(0);
    });

    it('inside the cancel cutoff the reminder says to contact the trainer', async () => {
      const w = await world(ctx);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
      await ctx.prisma.session.create({
        data: {
          slotId: slot.id,
          trainerId: w.trainer.user.id,
          clientId: w.client.user.id,
          packageId: w.pkg.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          createdById: w.trainer.user.id,
        },
      });
      // e.g. the API was down: first run only 5h before the start
      expect(
        await notifications.sendDueReminders(new Date(slot.startsAt.getTime() - 5 * HOUR)),
      ).toBe(1);
      const [mail] = mailsTo(ctx, w.client.user.email);
      expect(mail!.text).toContain('Ako ne možete da dođete, javite se treneru.');
      expect(mail!.text).toContain('If you cannot make it, contact your trainer.');
    });

    it('a failed send releases the claim so the next run retries', async () => {
      const w = await world(ctx);
      const slot = await addSlot(ctx, w.trainer.user.id, local('2026-10-07', '18:00'));
      const s = await ctx.prisma.session.create({
        data: {
          slotId: slot.id,
          trainerId: w.trainer.user.id,
          clientId: w.client.user.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          createdById: w.trainer.user.id,
        },
      });
      const at = new Date(slot.startsAt.getTime() - 20 * HOUR);
      const send = ctx.mailer.send.bind(ctx.mailer);
      ctx.mailer.send = async () => false;
      try {
        expect(await notifications.sendDueReminders(at)).toBe(0);
      } finally {
        ctx.mailer.send = send;
      }
      expect(
        (await ctx.prisma.session.findUniqueOrThrow({ where: { id: s.id } })).reminderSentAt,
      ).toBeNull();
      expect(await notifications.sendDueReminders(new Date(at.getTime() + 15 * MINUTE))).toBe(1);
    });

    it('overlapping runs never double-send', async () => {
      const w = await world(ctx);
      // 1h and 23h after the run
      for (const [day, time] of [
        ['2026-10-06', '09:00'],
        ['2026-10-07', '07:00'],
      ] as const) {
        const slot = await addSlot(ctx, w.trainer.user.id, local(day, time));
        await ctx.prisma.session.create({
          data: {
            slotId: slot.id,
            trainerId: w.trainer.user.id,
            clientId: w.client.user.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            createdById: w.trainer.user.id,
          },
        });
      }
      const at = new Date('2026-10-06T06:00:00Z');
      const results = await Promise.all([1, 2, 3, 4].map(() => notifications.sendDueReminders(at)));
      expect(results.reduce((a, b) => a + b, 0)).toBe(2);
      expect(mailsTo(ctx, w.client.user.email)).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------------ expiring packages

  describe('package expiring digest (to the trainer)', () => {
    it('lists active packages ending within 5 days with practices left, once per end date', async () => {
      const t = await trainer(ctx);
      const ana = await clientOf(ctx, t.user.id, { firstName: 'Ana', lastName: 'A' });
      const boris = await clientOf(ctx, t.user.id, { firstName: 'Boris', lastName: 'B' });
      const cedo = await clientOf(ctx, t.user.id, { firstName: 'Čedo', lastName: 'C' });
      const gone = await clientOf(ctx, t.user.id, {
        firstName: 'Gone',
        lastName: 'G',
        archived: true,
      });
      const today = '2026-10-05';
      const endsIn5 = await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: ana.user.id,
        validFrom: '2026-09-11',
        validUntil: '2026-10-10',
        total: 10,
      });
      // ends today (0 days) — still listed
      await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: boris.user.id,
        validFrom: '2026-09-06',
        validUntil: today,
        total: 10,
      });
      // ends in 6 days: not yet
      await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: cedo.user.id,
        validFrom: '2026-09-12',
        validUntil: '2026-10-11',
      });
      // archived client: ignored
      await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: gone.user.id,
        validFrom: '2026-09-11',
        validUntil: '2026-10-08',
      });
      // used up: nothing to lose
      const usedUp = await clientOf(ctx, t.user.id, { firstName: 'Used', lastName: 'U' });
      const pkg = await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: usedUp.user.id,
        validFrom: '2026-09-11',
        validUntil: '2026-10-08',
        total: 1,
      });
      await ctx.prisma.package.update({ where: { id: pkg.id }, data: { adjustment: -1 } });
      // another trainer's client
      const other = await trainer(ctx, 'Other');
      const oc = await clientOf(ctx, other.user.id, { firstName: 'Olga', lastName: 'O' });
      await addPackage(ctx, {
        trainerId: other.user.id,
        clientId: oc.user.id,
        validFrom: '2026-09-11',
        validUntil: '2026-10-07',
      });

      expect(await notifications.sendExpiringPackageDigests(new Date('2026-10-05T06:00:00Z'))).toBe(
        2,
      );
      const [mine] = mailsTo(ctx, t.user.email);
      expect(mine!.subject).toBe('Paketi ističu uskoro (2) · Packages expiring soon');
      expect(mine!.text).toContain(
        '• Boris B — 10 practices / month: preostalo treninga 10, važi do 5. oktobar 2026.',
      );
      expect(mine!.text).toContain(
        '• Ana A — 10 practices / month: preostalo treninga 10, važi do 10. oktobar 2026.',
      );
      expect(mine!.text).toContain(
        '• Ana A — 10 practices / month: 10 practices left, valid until 10 October 2026',
      );
      expect(mine!.text).not.toMatch(/Čedo|Gone|Used|Olga/);
      expect(mine!.html).toContain('/trainer/clients?flag=EXPIRING');
      const [theirs] = mailsTo(ctx, other.user.email);
      expect(theirs!.subject).toBe('Paket ističe: Olga O · Package expiring soon');

      // a later run the same day: nothing new
      expect(await notifications.sendExpiringPackageDigests(new Date('2026-10-05T12:00:00Z'))).toBe(
        0,
      );
      // Ana's package is extended to the 15th (out of the window for now); the next day only Čedo's is new
      await ctx.prisma.package.update({
        where: { id: endsIn5.id },
        data: { extendedUntil: new Date('2026-10-15T00:00:00Z') },
      });
      ctx.mailer.sent.length = 0;
      expect(await notifications.sendExpiringPackageDigests(new Date('2026-10-06T06:00:00Z'))).toBe(
        1,
      );
      const [next] = mailsTo(ctx, t.user.email);
      expect(next!.subject).toBe('Paket ističe: Čedo C · Package expiring soon');
      expect(next!.text).toContain('važi do 11. oktobar 2026.');
      // five days before the new end date Ana's package is announced again
      ctx.mailer.sent.length = 0;
      expect(await notifications.sendExpiringPackageDigests(new Date('2026-10-10T06:00:00Z'))).toBe(
        1,
      );
      const [again] = mailsTo(ctx, t.user.email);
      expect(again!.subject).toBe('Paket ističe: Ana A · Package expiring soon');
      expect(again!.text).toContain('važi do 15. oktobar 2026.');
    });

    it('a failed digest is retried on the next run', async () => {
      const t = await trainer(ctx);
      const c = await clientOf(ctx, t.user.id);
      await addPackage(ctx, {
        trainerId: t.user.id,
        clientId: c.user.id,
        validFrom: '2026-09-11',
        validUntil: '2026-10-08',
      });
      const send = ctx.mailer.send.bind(ctx.mailer);
      ctx.mailer.send = async () => false;
      try {
        expect(
          await notifications.sendExpiringPackageDigests(new Date('2026-10-05T06:00:00Z')),
        ).toBe(0);
      } finally {
        ctx.mailer.send = send;
      }
      expect(await ctx.prisma.notificationLog.count()).toBe(0);
      expect(await notifications.sendExpiringPackageDigests(new Date('2026-10-05T07:00:00Z'))).toBe(
        1,
      );
    });
  });
});
