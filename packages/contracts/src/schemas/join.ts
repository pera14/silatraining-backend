import { z } from 'zod';
import { Email, Password, PersonName, Phone } from './common';

/** `GET /join/:token` — what the Login Invite screen shows. */
export const JoinInfo = z.object({
  trainerName: z.string(),
  trainerFirstName: z.string(),
  trainerPhotoUrl: z.string().nullable(),
});
export type JoinInfo = z.infer<typeof JoinInfo>;

export const JoinRegisterRequest = z.object({
  firstName: PersonName,
  lastName: PersonName,
  email: Email,
  /** Optional in the design ("for session reminders"); empty string is treated as absent. */
  phone: z
    .union([Phone, z.literal('')])
    .optional()
    .transform((v) => (v ? v : undefined)),
  password: Password,
  consent: z.literal(true, { error: 'You must agree to continue' }),
});
export type JoinRegisterRequest = z.input<typeof JoinRegisterRequest>;

/** `POST /join/:token/accept` — an existing, signed-in client links to the trainer. */
export const JoinAcceptResponse = z.object({
  trainerName: z.string(),
  /** false when the client was already linked to this same trainer (idempotent accept). */
  linked: z.boolean(),
});
export type JoinAcceptResponse = z.infer<typeof JoinAcceptResponse>;

/** `GET /trainer/join-link` and `POST /trainer/join-link/regenerate`. */
export const JoinLinkResponse = z.object({
  url: z.url(),
  /** Standalone `<svg>` markup of the QR code for `url`. */
  qrSvg: z.string().startsWith('<svg'),
  createdAt: z.iso.datetime({ offset: true }),
});
export type JoinLinkResponse = z.infer<typeof JoinLinkResponse>;
