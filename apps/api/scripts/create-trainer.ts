/**
 * Creates a TRAINER account. Production is never seeded; this is the only way to create the first trainers
 * (clients join through a trainer's join link).
 *
 *   local:      pnpm --filter @sila/api user:create-trainer --email a@b.rs --first-name Marko --last-name Ilić
 *   production: docker compose --env-file .env.prod exec api \
 *                 node dist/cli/scripts/create-trainer.js --email a@b.rs --first-name Marko --last-name Ilić
 *
 * The password is never taken from argv (it would land in shell history and `ps`): it is prompted twice
 * without echo on a TTY, or read from the first line of stdin otherwise (`... exec -T api node ... < pw.txt`).
 * Weak passwords are refused (see `passwordProblems`). An existing e-mail is refused, never overwritten.
 *
 * Exit codes: 0 created · 1 refused/invalid input · 2 unexpected error.
 */
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { Email, PersonName, Phone } from '@sila/contracts';
import type { z } from 'zod';
import { hashPassword } from '../src/common/crypto/password';
import { PrismaClient } from '../src/generated/prisma/client';

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;
const COMMON = [
  'password',
  'passw0rd',
  'qwerty',
  'letmein',
  'welcome',
  'admin',
  'sila',
  'training',
  'trainer',
  '123456',
  'abc123',
  'iloveyou',
];

class InputError extends Error {}

/** Human-readable reasons a password is too weak; empty when it is acceptable. */
export function passwordProblems(password: string, personal: string[]): string[] {
  const problems: string[] = [];
  if (password.length < MIN_LENGTH) problems.push(`use at least ${MIN_LENGTH} characters`);
  if (password.length > MAX_LENGTH) problems.push(`use at most ${MAX_LENGTH} characters`);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password));
  if (classes.length < 3) {
    problems.push('mix at least 3 of: lower-case, upper-case, digits, symbols');
  }
  if (new Set(password).size < 6) problems.push('use more distinct characters');
  const lower = password.toLowerCase();
  if (COMMON.some((w) => lower.includes(w))) problems.push('avoid common words such as "password"');
  if (personal.some((p) => p.length >= 3 && lower.includes(p.toLowerCase()))) {
    problems.push('do not include your name or e-mail');
  }
  return problems;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, flag: string): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new InputError(`invalid ${flag}: ${r.error.issues[0]?.message ?? 'required'}`);
  return r.data;
}

/** Reads one line from a TTY without echoing it. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    process.stderr.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new InputError('aborted'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdinLine(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk as string;
  return data.split(/\r?\n/)[0] ?? '';
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readStdinLine();
  const first = await promptHidden('Password: ');
  const second = await promptHidden('Repeat password: ');
  if (first !== second) throw new InputError('passwords do not match');
  return first;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      'first-name': { type: 'string' },
      'last-name': { type: 'string' },
      phone: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      'Usage: create-trainer --email <email> --first-name <name> --last-name <name> [--phone <phone>]\n' +
        'The password is prompted (TTY) or read from the first line of stdin.',
    );
    return;
  }
  const email = parse(Email, values.email, '--email');
  const firstName = parse(PersonName, values['first-name'], '--first-name');
  const lastName = parse(PersonName, values['last-name'], '--last-name');
  const phone = values.phone === undefined ? null : parse(Phone, values.phone, '--phone');

  const url = process.env.DATABASE_URL;
  if (!url) throw new InputError('DATABASE_URL is not set');

  const password = await readPassword();
  const problems = passwordProblems(password, [email.split('@')[0] ?? '', firstName, lastName]);
  if (problems.length > 0) throw new InputError(`weak password: ${problems.join('; ')}`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new InputError(`a user with e-mail ${email} already exists (nothing changed)`);
    }
    const user = await prisma.user.create({
      data: {
        role: 'TRAINER',
        email,
        firstName,
        lastName,
        phone,
        passwordHash: await hashPassword(password),
      },
      select: { id: true },
    });
    console.log(`created trainer ${email} (id ${user.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof InputError) {
    console.error(`✖ ${err.message}`);
    process.exitCode = 1;
  } else if (err instanceof Error && 'code' in err && err.code === 'P2002') {
    console.error('✖ a user with that e-mail already exists (nothing changed)');
    process.exitCode = 1;
  } else {
    console.error(err);
    process.exitCode = 2;
  }
});
