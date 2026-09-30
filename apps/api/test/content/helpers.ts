import type { MailMessage } from '../../src/common/mailer/mailer.service';
import type { SchedulingContext } from '../scheduling/app';

/** Polls until `check` passes (async event handlers, e.g. emails), or fails with its last error. */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      return await check();
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw lastError;
}

/** Lets pending async event handlers finish, for "no email was sent" assertions. */
export async function settle(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export function mailsTo(ctx: SchedulingContext, email: string): MailMessage[] {
  return ctx.mailer.sent.filter((m) => m.to === email);
}

export async function addExercise(
  ctx: SchedulingContext,
  trainerId: string,
  name: string,
  data: { category?: string; archived?: boolean } = {},
) {
  return ctx.prisma.exercise.create({
    data: {
      trainerId,
      name,
      category: data.category ?? null,
      archivedAt: data.archived ? new Date() : null,
    },
  });
}
