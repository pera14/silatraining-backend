import { z } from 'zod';
import type { ErrorCode } from './errors';
import {
  AuthResponse,
  ForgotPasswordRequest,
  LoginRequest,
  Me,
  ResetPasswordRequest,
  UpdateProfileRequest,
} from './schemas/auth';
import {
  ClientBookRequest,
  ClientHome,
  ClientPractice,
  ClientSessionsQuery,
  ClientSlot,
} from './schemas/client';
import { ClientDetail, ClientListItem, ClientsQuery, UpdateClientRequest } from './schemas/clients';
import { IdParams, NoContent, TokenParams } from './schemas/common';
import {
  CalendarFeedParams,
  CalendarFeedResponse,
  CreateClientPlanRequest,
  CreateDocumentRequest,
  CreateDocumentResponse,
  CreateExerciseRequest,
  CreateNoteRequest,
  CreatePlanRequest,
  Document,
  DocumentDownloadResponse,
  Exercise,
  ExercisesQuery,
  Note,
  Plan,
  PlansQuery,
  PutPlanExercisesRequest,
  UpdateExerciseRequest,
  UpdateNoteRequest,
  UpdatePlanRequest,
} from './schemas/content';
import {
  JoinAcceptResponse,
  JoinInfo,
  JoinLinkResponse,
  JoinRegisterRequest,
} from './schemas/join';
import {
  AdjustPackageRequest,
  CreatePackageRequest,
  CreatePackageTypeRequest,
  ExtendPackageRequest,
  Package,
  PackageType,
  PackageTypesQuery,
  UpdatePackageRequest,
  UpdatePackageTypeRequest,
} from './schemas/packages';
import {
  CalendarResponse,
  CreateSlotSeriesRequest,
  CreateSlotsRequest,
  CreateSlotsResponse,
  CreateTrainerSessionRequest,
  LockRangeRequest,
  LockRangeResponse,
  MoveSessionRequest,
  RangeQuery,
  SlotSeries,
  TodayQuery,
  TodayResponse,
  TrainerCancelSessionRequest,
  TrainerPractice,
  TrainerSlot,
  UpdateSlotRequest,
  UpdateSlotSeriesRequest,
  UpdateTrainerSessionRequest,
} from './schemas/scheduling';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** Who may call the endpoint. `authenticated` = any signed-in role. */
export type Access = 'public' | 'authenticated' | 'TRAINER' | 'CLIENT';

export interface EndpointDef {
  method: HttpMethod;
  /** Path under `/api`, Express-style params (`/trainer/slots/:id`). */
  path: string;
  access: Access;
  summary: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  /** 200 unless stated. 204 responses have no body (`NoContent`). */
  status?: 200 | 201 | 204;
  /** `text` for non-JSON responses (the iCal feed). */
  responseType?: 'json' | 'text';
  /** Domain errors this endpoint may return, beyond the generic VALIDATION_FAILED / UNAUTHORIZED / FORBIDDEN / RATE_LIMITED. */
  errors: readonly ErrorCode[];
}

const def = <const E extends EndpointDef>(e: E): E => e;

/** Client-visible package history hides the trainer's private payment note. */
export const ClientPackage = Package.omit({ paymentNote: true });
export type ClientPackage = z.infer<typeof ClientPackage>;

export const HealthResponse = z.object({ status: z.literal('ok'), db: z.literal('ok') });

/**
 * Every API endpoint (SPEC §5). Add new endpoints here FIRST (additive only during the parallel phase,
 * logged in docs/CONTRACT_CHANGES.md), then implement them in the API and consume them in the web app.
 */
export const endpoints = {
  // ------------------------------------------------------------------ system
  health: def({
    method: 'GET',
    path: '/health',
    access: 'public',
    summary: 'Liveness + DB ping',
    response: HealthResponse,
    errors: [],
  }),

  // ------------------------------------------------------------------ auth (public)
  'auth.login': def({
    method: 'POST',
    path: '/auth/login',
    access: 'public',
    summary: 'Sign in; sets the refresh cookie. 5/min/IP.',
    body: LoginRequest,
    response: AuthResponse,
    errors: ['INVALID_CREDENTIALS'],
  }),
  'auth.refresh': def({
    method: 'POST',
    path: '/auth/refresh',
    access: 'public',
    summary: 'Rotate the refresh cookie and issue a new access token',
    response: AuthResponse,
    errors: ['TOKEN_INVALID'],
  }),
  'auth.logout': def({
    method: 'POST',
    path: '/auth/logout',
    access: 'public',
    summary: 'Revoke the refresh token and clear cookies',
    response: NoContent,
    status: 204,
    errors: [],
  }),
  'auth.forgotPassword': def({
    method: 'POST',
    path: '/auth/password/forgot',
    access: 'public',
    summary: 'Email a reset link (always 204)',
    body: ForgotPasswordRequest,
    response: NoContent,
    status: 204,
    errors: [],
  }),
  'auth.resetPassword': def({
    method: 'POST',
    path: '/auth/password/reset',
    access: 'public',
    summary: 'Set a new password with a reset token',
    body: ResetPasswordRequest,
    response: NoContent,
    status: 204,
    errors: ['RESET_TOKEN_INVALID'],
  }),
  'me.get': def({
    method: 'GET',
    path: '/me',
    access: 'authenticated',
    summary: 'Current user + role',
    response: Me,
    errors: [],
  }),

  // ------------------------------------------------------------------ join (public)
  'join.get': def({
    method: 'GET',
    path: '/join/:token',
    access: 'public',
    summary: 'Trainer shown on the Login Invite screen',
    params: TokenParams,
    response: JoinInfo,
    errors: ['LINK_REVOKED'],
  }),
  'join.register': def({
    method: 'POST',
    path: '/join/:token/register',
    access: 'public',
    summary: 'Create a client account linked to the trainer and sign in',
    params: TokenParams,
    body: JoinRegisterRequest,
    response: AuthResponse,
    status: 201,
    errors: ['LINK_REVOKED', 'EMAIL_TAKEN'],
  }),
  'join.accept': def({
    method: 'POST',
    path: '/join/:token/accept',
    access: 'CLIENT',
    summary: 'Signed-in existing client links to the trainer',
    params: TokenParams,
    response: JoinAcceptResponse,
    errors: ['LINK_REVOKED', 'ALREADY_LINKED'],
  }),

  // ------------------------------------------------------------------ trainer: profile + join link + feed
  'trainer.profile.update': def({
    method: 'PATCH',
    path: '/trainer/profile',
    access: 'TRAINER',
    summary: 'Update own profile',
    body: UpdateProfileRequest,
    response: Me,
    errors: ['INVALID_CREDENTIALS'],
  }),
  'trainer.joinLink.get': def({
    method: 'GET',
    path: '/trainer/join-link',
    access: 'TRAINER',
    summary: 'Active join link as URL + QR SVG (created on first call)',
    response: JoinLinkResponse,
    errors: [],
  }),
  'trainer.joinLink.regenerate': def({
    method: 'POST',
    path: '/trainer/join-link/regenerate',
    access: 'TRAINER',
    summary: 'Revoke the old link and create a new one',
    response: JoinLinkResponse,
    errors: [],
  }),
  'trainer.calendarFeed.get': def({
    method: 'GET',
    path: '/trainer/calendar-feed',
    access: 'TRAINER',
    summary: 'iCal feed URL (created on first call)',
    response: CalendarFeedResponse,
    errors: [],
  }),
  'trainer.calendarFeed.regenerate': def({
    method: 'POST',
    path: '/trainer/calendar-feed/regenerate',
    access: 'TRAINER',
    summary: 'Revoke the old feed URL and create a new one',
    response: CalendarFeedResponse,
    errors: [],
  }),
  'calendarFeed.ics': def({
    method: 'GET',
    path: '/calendar/:token.ics',
    access: 'public',
    summary: 'Public iCal feed of the trainer’s practices',
    params: CalendarFeedParams,
    response: z.string(),
    responseType: 'text',
    errors: ['NOT_FOUND'],
  }),

  // ------------------------------------------------------------------ trainer: today + calendar
  'trainer.today': def({
    method: 'GET',
    path: '/trainer/today',
    access: 'TRAINER',
    summary: 'Practices of a day (default today) with pinned note, plan, package',
    query: TodayQuery,
    response: TodayResponse,
    errors: [],
  }),
  'trainer.calendar': def({
    method: 'GET',
    path: '/trainer/calendar',
    access: 'TRAINER',
    summary: 'Slots + practices in range',
    query: RangeQuery,
    response: CalendarResponse,
    errors: [],
  }),

  // ------------------------------------------------------------------ trainer: slots
  'trainer.slots.create': def({
    method: 'POST',
    path: '/trainer/slots',
    access: 'TRAINER',
    summary: 'Single `{startsAt}` or bulk `{dates, times}`; rejects overlaps',
    body: CreateSlotsRequest,
    response: CreateSlotsResponse,
    status: 201,
    errors: ['SLOT_OVERLAP'],
  }),
  'trainer.slots.update': def({
    method: 'PATCH',
    path: '/trainer/slots/:id',
    access: 'TRAINER',
    summary: 'Lock/unlock, lock reason, reserve for a client',
    params: IdParams,
    body: UpdateSlotRequest,
    response: TrainerSlot,
    errors: ['NOT_FOUND', 'SLOT_BOOKED'],
  }),
  'trainer.slots.delete': def({
    method: 'DELETE',
    path: '/trainer/slots/:id',
    access: 'TRAINER',
    summary: 'Delete an unbooked slot',
    params: IdParams,
    response: NoContent,
    status: 204,
    errors: ['NOT_FOUND', 'SLOT_BOOKED'],
  }),
  'trainer.slots.lockRange': def({
    method: 'POST',
    path: '/trainer/slots/lock-range',
    access: 'TRAINER',
    summary: 'Lock every open slot in a range (break)',
    body: LockRangeRequest,
    response: LockRangeResponse,
    errors: [],
  }),
  'trainer.slotSeries.list': def({
    method: 'GET',
    path: '/trainer/slot-series',
    access: 'TRAINER',
    summary: 'Repeating series',
    response: z.array(SlotSeries),
    errors: [],
  }),
  'trainer.slotSeries.create': def({
    method: 'POST',
    path: '/trainer/slot-series',
    access: 'TRAINER',
    summary: 'Create a series and materialize its slots',
    body: CreateSlotSeriesRequest,
    response: SlotSeries,
    status: 201,
    errors: ['SLOT_OVERLAP', 'NOT_FOUND'],
  }),
  'trainer.slotSeries.update': def({
    method: 'PATCH',
    path: '/trainer/slot-series/:id',
    access: 'TRAINER',
    summary: 'Edit; affects future unbooked slots only',
    params: IdParams,
    body: UpdateSlotSeriesRequest,
    response: SlotSeries,
    errors: ['NOT_FOUND', 'SLOT_OVERLAP'],
  }),
  'trainer.slotSeries.delete': def({
    method: 'DELETE',
    path: '/trainer/slot-series/:id',
    access: 'TRAINER',
    summary: 'End the series; removes future unbooked slots',
    params: IdParams,
    response: NoContent,
    status: 204,
    errors: ['NOT_FOUND'],
  }),

  // ------------------------------------------------------------------ trainer: practices
  'trainer.sessions.create': def({
    method: 'POST',
    path: '/trainer/sessions',
    access: 'TRAINER',
    summary: 'Book a slot for a client (no cutoff)',
    body: CreateTrainerSessionRequest,
    response: TrainerPractice,
    status: 201,
    errors: ['NOT_FOUND', 'NO_PACKAGE', 'SLOT_TAKEN'],
  }),
  'trainer.sessions.update': def({
    method: 'PATCH',
    path: '/trainer/sessions/:id',
    access: 'TRAINER',
    summary: 'Attendance (Came / Didn’t come) and plan',
    params: IdParams,
    body: UpdateTrainerSessionRequest,
    response: TrainerPractice,
    errors: ['NOT_FOUND'],
  }),
  'trainer.sessions.move': def({
    method: 'POST',
    path: '/trainer/sessions/:id/move',
    access: 'TRAINER',
    summary: 'Move to another free slot, keeping package and plan',
    params: IdParams,
    body: MoveSessionRequest,
    response: TrainerPractice,
    errors: ['NOT_FOUND', 'SLOT_TAKEN'],
  }),
  'trainer.sessions.cancel': def({
    method: 'POST',
    path: '/trainer/sessions/:id/cancel',
    access: 'TRAINER',
    summary: 'Cancel anytime; optionally return the practice',
    params: IdParams,
    body: TrainerCancelSessionRequest,
    response: TrainerPractice,
    errors: ['NOT_FOUND'],
  }),

  // ------------------------------------------------------------------ trainer: clients
  'trainer.clients.list': def({
    method: 'GET',
    path: '/trainer/clients',
    access: 'TRAINER',
    summary: 'Clients with left, validUntil, payment, next practice, flags',
    query: ClientsQuery,
    response: z.array(ClientListItem),
    errors: [],
  }),
  'trainer.clients.get': def({
    method: 'GET',
    path: '/trainer/clients/:id',
    access: 'TRAINER',
    summary: 'Client profile',
    params: IdParams,
    response: ClientDetail,
    errors: ['NOT_FOUND'],
  }),
  'trainer.clients.update': def({
    method: 'PATCH',
    path: '/trainer/clients/:id',
    access: 'TRAINER',
    summary: 'Archive / unarchive',
    params: IdParams,
    body: UpdateClientRequest,
    response: ClientDetail,
    errors: ['NOT_FOUND'],
  }),

  // ------------------------------------------------------------------ trainer: packages
  'trainer.packages.listForClient': def({
    method: 'GET',
    path: '/trainer/clients/:id/packages',
    access: 'TRAINER',
    summary: 'Package history, newest first',
    params: IdParams,
    response: z.array(Package),
    errors: ['NOT_FOUND'],
  }),
  'trainer.packages.create': def({
    method: 'POST',
    path: '/trainer/clients/:id/packages',
    access: 'TRAINER',
    summary: 'Add a package (validUntil = start + 1 month − 1 day)',
    params: IdParams,
    body: CreatePackageRequest,
    response: Package,
    status: 201,
    errors: ['NOT_FOUND'],
  }),
  'trainer.packages.update': def({
    method: 'PATCH',
    path: '/trainer/packages/:id',
    access: 'TRAINER',
    summary: 'Payment fields (mark paid)',
    params: IdParams,
    body: UpdatePackageRequest,
    response: Package,
    errors: ['NOT_FOUND'],
  }),
  'trainer.packages.extend': def({
    method: 'POST',
    path: '/trainer/packages/:id/extend',
    access: 'TRAINER',
    summary: 'Approve an extension (≤ start + 5 weeks − 1 day)',
    params: IdParams,
    body: ExtendPackageRequest,
    response: Package,
    errors: ['NOT_FOUND', 'EXTENSION_LIMIT'],
  }),
  'trainer.packages.adjust': def({
    method: 'POST',
    path: '/trainer/packages/:id/adjust',
    access: 'TRAINER',
    summary: 'Manual ±N practices with a note (audit-logged)',
    params: IdParams,
    body: AdjustPackageRequest,
    response: Package,
    errors: ['NOT_FOUND'],
  }),
  'trainer.packageTypes.list': def({
    method: 'GET',
    path: '/trainer/package-types',
    access: 'TRAINER',
    summary: 'Package catalog',
    query: PackageTypesQuery,
    response: z.array(PackageType),
    errors: [],
  }),
  'trainer.packageTypes.create': def({
    method: 'POST',
    path: '/trainer/package-types',
    access: 'TRAINER',
    summary: 'Add a package type',
    body: CreatePackageTypeRequest,
    response: PackageType,
    status: 201,
    errors: [],
  }),
  'trainer.packageTypes.get': def({
    method: 'GET',
    path: '/trainer/package-types/:id',
    access: 'TRAINER',
    summary: 'One package type',
    params: IdParams,
    response: PackageType,
    errors: ['NOT_FOUND'],
  }),
  'trainer.packageTypes.update': def({
    method: 'PATCH',
    path: '/trainer/package-types/:id',
    access: 'TRAINER',
    summary: 'Edit / archive a package type',
    params: IdParams,
    body: UpdatePackageTypeRequest,
    response: PackageType,
    errors: ['NOT_FOUND'],
  }),
  'trainer.packageTypes.delete': def({
    method: 'DELETE',
    path: '/trainer/package-types/:id',
    access: 'TRAINER',
    summary: 'Archive a package type',
    params: IdParams,
    response: NoContent,
    status: 204,
    errors: ['NOT_FOUND'],
  }),

  // ------------------------------------------------------------------ trainer: notes
  'trainer.notes.list': def({
    method: 'GET',
    path: '/trainer/clients/:id/notes',
    access: 'TRAINER',
    summary: 'Notes, pinned first then newest',
    params: IdParams,
    response: z.array(Note),
    errors: ['NOT_FOUND'],
  }),
  'trainer.notes.create': def({
    method: 'POST',
    path: '/trainer/clients/:id/notes',
    access: 'TRAINER',
    summary: 'Add a note',
    params: IdParams,
    body: CreateNoteRequest,
    response: Note,
    status: 201,
    errors: ['NOT_FOUND'],
  }),
  'trainer.notes.update': def({
    method: 'PATCH',
    path: '/trainer/notes/:id',
    access: 'TRAINER',
    summary: 'Edit / pin (one pinned per client)',
    params: IdParams,
    body: UpdateNoteRequest,
    response: Note,
    errors: ['NOT_FOUND'],
  }),
  'trainer.notes.delete': def({
    method: 'DELETE',
    path: '/trainer/notes/:id',
    access: 'TRAINER',
    summary: 'Delete a note',
    params: IdParams,
    response: NoContent,
    status: 204,
    errors: ['NOT_FOUND'],
  }),

  // ------------------------------------------------------------------ trainer: exercises
  'trainer.exercises.list': def({
    method: 'GET',
    path: '/trainer/exercises',
    access: 'TRAINER',
    summary: 'Exercise library',
    query: ExercisesQuery,
    response: z.array(Exercise),
    errors: [],
  }),
  'trainer.exercises.create': def({
    method: 'POST',
    path: '/trainer/exercises',
    access: 'TRAINER',
    summary: 'Add an exercise',
    body: CreateExerciseRequest,
    response: Exercise,
    status: 201,
    errors: [],
  }),
  'trainer.exercises.get': def({
    method: 'GET',
    path: '/trainer/exercises/:id',
    access: 'TRAINER',
    summary: 'One exercise',
    params: IdParams,
    response: Exercise,
    errors: ['NOT_FOUND'],
  }),
  'trainer.exercises.update': def({
    method: 'PATCH',
    path: '/trainer/exercises/:id',
    access: 'TRAINER',
    summary: 'Edit an exercise',
    params: IdParams,
    body: UpdateExerciseRequest,
    response: Exercise,
    errors: ['NOT_FOUND'],
  }),
  'trainer.exercises.delete': def({
    method: 'DELETE',
    path: '/trainer/exercises/:id',
    access: 'TRAINER',
    summary: 'Archive an exercise',
    params: IdParams,
    response: NoContent,
    status: 204,
    errors: ['NOT_FOUND'],
  }),

  // ------------------------------------------------------------------ trainer: plans
  'trainer.plans.list': def({
    method: 'GET',
    path: '/trainer/plans',
    access: 'TRAINER',
    summary: 'Plans; `?template=true` for templates',
    query: PlansQuery,
    response: z.array(Plan),
    errors: [],
  }),
  'trainer.plans.create': def({
    method: 'POST',
    path: '/trainer/plans',
    access: 'TRAINER',
    summary: 'Create a template',
    body: CreatePlanRequest,
    response: Plan,
    status: 201,
    errors: [],
  }),
  'trainer.plans.get': def({
    method: 'GET',
    path: '/trainer/plans/:id',
    access: 'TRAINER',
    summary: 'One plan with exercises',
    params: IdParams,
    response: Plan,
    errors: ['NOT_FOUND'],
  }),
  'trainer.plans.update': def({
    method: 'PATCH',
    path: '/trainer/plans/:id',
    access: 'TRAINER',
    summary: 'Rename / notes / rotation order',
    params: IdParams,
    body: UpdatePlanRequest,
    response: Plan,
    errors: ['NOT_FOUND'],
  }),
  'trainer.plans.delete': def({
    method: 'DELETE',
    path: '/trainer/plans/:id',
    access: 'TRAINER',
    summary: 'Archive a plan',
    params: IdParams,
    response: NoContent,
    status: 204,
    errors: ['NOT_FOUND'],
  }),
  'trainer.plans.putExercises': def({
    method: 'PUT',
    path: '/trainer/plans/:id/exercises',
    access: 'TRAINER',
    summary: 'Replace the ordered exercise list',
    params: IdParams,
    body: PutPlanExercisesRequest,
    response: Plan,
    errors: ['NOT_FOUND'],
  }),
  'trainer.clientPlans.list': def({
    method: 'GET',
    path: '/trainer/clients/:id/plans',
    access: 'TRAINER',
    summary: 'A client’s plans in rotation order',
    params: IdParams,
    response: z.array(Plan),
    errors: ['NOT_FOUND'],
  }),
  'trainer.clientPlans.create': def({
    method: 'POST',
    path: '/trainer/clients/:id/plans',
    access: 'TRAINER',
    summary: 'Copy a template (`fromTemplateId`) or create an empty plan',
    params: IdParams,
    body: CreateClientPlanRequest,
    response: Plan,
    status: 201,
    errors: ['NOT_FOUND'],
  }),

  // ------------------------------------------------------------------ trainer: documents
  'trainer.documents.list': def({
    method: 'GET',
    path: '/trainer/clients/:id/documents',
    access: 'TRAINER',
    summary: 'Confirmed, non-deleted documents',
    params: IdParams,
    response: z.array(Document),
    errors: ['NOT_FOUND'],
  }),
  'trainer.documents.create': def({
    method: 'POST',
    path: '/trainer/clients/:id/documents',
    access: 'TRAINER',
    summary: 'Start an upload: presigned PUT (5 min, ≤ 20 MB)',
    params: IdParams,
    body: CreateDocumentRequest,
    response: CreateDocumentResponse,
    status: 201,
    errors: ['NOT_FOUND'],
  }),
  'trainer.documents.confirm': def({
    method: 'POST',
    path: '/trainer/documents/:id/confirm',
    access: 'TRAINER',
    summary: 'Confirm the object exists after upload',
    params: IdParams,
    response: Document,
    errors: ['NOT_FOUND'],
  }),
  'trainer.documents.download': def({
    method: 'GET',
    path: '/trainer/documents/:id/download',
    access: 'TRAINER',
    summary: 'Presigned GET (60 s), audit-logged',
    params: IdParams,
    response: DocumentDownloadResponse,
    errors: ['NOT_FOUND'],
  }),
  'trainer.documents.delete': def({
    method: 'DELETE',
    path: '/trainer/documents/:id',
    access: 'TRAINER',
    summary: 'Soft delete (object purged after 30 days)',
    params: IdParams,
    response: NoContent,
    status: 204,
    errors: ['NOT_FOUND'],
  }),

  // ------------------------------------------------------------------ client
  'client.home': def({
    method: 'GET',
    path: '/client/home',
    access: 'CLIENT',
    summary: 'Practices left, valid until, next practice, trainer',
    response: ClientHome,
    errors: [],
  }),
  'client.slots': def({
    method: 'GET',
    path: '/client/slots',
    access: 'CLIENT',
    summary: 'Bookable slots (≥ 6h ahead), each flagged withinPackage',
    query: RangeQuery,
    response: z.array(ClientSlot),
    errors: [],
  }),
  'client.sessions.create': def({
    method: 'POST',
    path: '/client/sessions',
    access: 'CLIENT',
    summary: 'Book a slot',
    body: ClientBookRequest,
    response: ClientPractice,
    status: 201,
    errors: ['NOT_FOUND', 'NO_PACKAGE', 'SLOT_TAKEN', 'BOOKING_CUTOFF'],
  }),
  'client.sessions.list': def({
    method: 'GET',
    path: '/client/sessions',
    access: 'CLIENT',
    summary: 'Upcoming or past practices, with canCancel',
    query: ClientSessionsQuery,
    response: z.array(ClientPractice),
    errors: [],
  }),
  'client.sessions.cancel': def({
    method: 'POST',
    path: '/client/sessions/:id/cancel',
    access: 'CLIENT',
    summary: 'Cancel ≥ 6h ahead (practice returned)',
    params: IdParams,
    response: ClientPractice,
    errors: ['NOT_FOUND', 'CANCEL_CUTOFF'],
  }),
  'client.packages': def({
    method: 'GET',
    path: '/client/packages',
    access: 'CLIENT',
    summary: 'Package history',
    response: z.array(ClientPackage),
    errors: [],
  }),
  'client.profile.update': def({
    method: 'PATCH',
    path: '/client/profile',
    access: 'CLIENT',
    summary: 'Name, phone, photo, password',
    body: UpdateProfileRequest,
    response: Me,
    errors: ['INVALID_CREDENTIALS'],
  }),
} as const satisfies Record<string, EndpointDef>;

export type Endpoints = typeof endpoints;
export type EndpointKey = keyof Endpoints;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** What a caller passes: `{ params?, query?, body? }` with only the keys the endpoint defines. */
export type EndpointInput<K extends EndpointKey> = Simplify<
  (Endpoints[K] extends { params: infer P extends z.ZodType } ? { params: z.input<P> } : unknown) &
    (Endpoints[K] extends { query: infer Q extends z.ZodType } ? { query?: z.input<Q> } : unknown) &
    (Endpoints[K] extends { body: infer B extends z.ZodType } ? { body: z.input<B> } : unknown)
>;

/** Parsed request body as the server sees it (after defaults/transforms). */
export type EndpointBody<K extends EndpointKey> = Endpoints[K] extends {
  body: infer B extends z.ZodType;
}
  ? z.output<B>
  : never;
export type EndpointQuery<K extends EndpointKey> = Endpoints[K] extends {
  query: infer Q extends z.ZodType;
}
  ? z.output<Q>
  : never;
/** Response payload. */
export type EndpointResponse<K extends EndpointKey> = z.output<Endpoints[K]['response']>;

/** `/trainer/slots/:id` + `{ id }` → `/trainer/slots/<id>` (values URI-encoded). */
export function buildPath(path: string, params?: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`Missing path param "${name}" for ${path}`);
    return encodeURIComponent(value);
  });
}

/** Query object → `?a=1&b=2` (undefined/null dropped). */
export type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
