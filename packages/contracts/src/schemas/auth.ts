import { z } from 'zod';
import { Email, Id, IsoDateTime, Password, PersonName, PersonSummary, Phone, Role } from './common';

/** The signed-in user (`GET /me`). */
export const Me = z.object({
  id: Id,
  role: Role,
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  photoUrl: z.string().nullable(),
  consentAt: IsoDateTime.nullable(),
  /** For clients: the trainer they belong to (null if not linked yet). Always null for trainers. */
  trainer: PersonSummary.nullable(),
});
export type Me = z.infer<typeof Me>;

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1, 'Required').max(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * Returned by login, refresh and join/register. The refresh token is never in the body: it is set as an
 * httpOnly cookie scoped to `/api/auth`.
 */
export const AuthResponse = z.object({
  accessToken: z.string(),
  /** Access-token lifetime in seconds. */
  expiresIn: z.int().positive(),
  user: Me,
});
export type AuthResponse = z.infer<typeof AuthResponse>;

export const ForgotPasswordRequest = z.object({ email: Email });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequest>;

export const ResetPasswordRequest = z.object({
  token: z.string().min(16).max(128),
  password: Password,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

/** `PATCH /client/profile` and `PATCH /trainer/profile`. */
export const UpdateProfileRequest = z
  .object({
    firstName: PersonName.optional(),
    lastName: PersonName.optional(),
    phone: Phone.nullable().optional(),
    photoUrl: z.string().max(2048).nullable().optional(),
    password: z.object({ current: z.string().min(1).max(128), next: Password }).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;
