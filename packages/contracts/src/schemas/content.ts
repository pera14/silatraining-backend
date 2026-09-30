import { z } from 'zod';
import { Id, IsoDateTime } from './common';

// ---------------------------------------------------------------- notes

export const Note = z.object({
  id: Id,
  clientId: Id,
  body: z.string(),
  pinned: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Note = z.infer<typeof Note>;

export const CreateNoteRequest = z.object({
  body: z.string().trim().min(1).max(5000),
  pinned: z.boolean().optional(),
});
export type CreateNoteRequest = z.infer<typeof CreateNoteRequest>;

/** Pinning a note unpins the client's previous pinned note. */
export const UpdateNoteRequest = z
  .object({ body: z.string().trim().min(1).max(5000).optional(), pinned: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequest>;

// ---------------------------------------------------------------- exercises

export const Exercise = z.object({
  id: Id,
  name: z.string(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  videoUrl: z.url().nullable(),
  archivedAt: IsoDateTime.nullable(),
});
export type Exercise = z.infer<typeof Exercise>;

export const CreateExerciseRequest = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  videoUrl: z.url().max(2048).nullable().optional(),
});
export type CreateExerciseRequest = z.infer<typeof CreateExerciseRequest>;

export const UpdateExerciseRequest = CreateExerciseRequest.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Nothing to update' },
);
export type UpdateExerciseRequest = z.infer<typeof UpdateExerciseRequest>;

export const ExercisesQuery = z.object({
  q: z.string().trim().max(80).optional(),
  includeArchived: z.stringbool().optional(),
});

// ---------------------------------------------------------------- plans

export const PlanExercise = z.object({
  id: Id,
  exercise: Exercise.pick({ id: true, name: true, category: true, videoUrl: true }),
  sets: z.int().positive().nullable(),
  reps: z.string().nullable(),
  weight: z.string().nullable(),
  restSec: z.int().nonnegative().nullable(),
  notes: z.string().nullable(),
  sortOrder: z.int(),
});
export type PlanExercise = z.infer<typeof PlanExercise>;

export const Plan = z.object({
  id: Id,
  /** null = template */
  clientId: Id.nullable(),
  name: z.string(),
  notes: z.string().nullable(),
  sortOrder: z.int(),
  archivedAt: IsoDateTime.nullable(),
  exercises: z.array(PlanExercise),
});
export type Plan = z.infer<typeof Plan>;

export const PlansQuery = z.object({ template: z.stringbool().optional() });

export const CreatePlanRequest = z.object({
  name: z.string().trim().min(1).max(60),
  notes: z.string().trim().max(2000).nullable().optional(),
  sortOrder: z.int().nonnegative().optional(),
});
export type CreatePlanRequest = z.infer<typeof CreatePlanRequest>;

export const UpdatePlanRequest = CreatePlanRequest.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Nothing to update' },
);
export type UpdatePlanRequest = z.infer<typeof UpdatePlanRequest>;

/** `POST /trainer/clients/:id/plans` — copy a template (deep copy) or create an empty plan. */
export const CreateClientPlanRequest = z
  .object({
    fromTemplateId: Id.optional(),
    name: z.string().trim().min(1).max(60).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    sortOrder: z.int().nonnegative().optional(),
  })
  .refine((v) => !!v.fromTemplateId || !!v.name, {
    message: 'Provide fromTemplateId or name',
  });
export type CreateClientPlanRequest = z.infer<typeof CreateClientPlanRequest>;

/** `PUT /trainer/plans/:id/exercises` — full ordered list; array order becomes sortOrder. */
export const PutPlanExercisesRequest = z.object({
  items: z
    .array(
      z.object({
        exerciseId: Id,
        sets: z.int().positive().max(50).nullable().optional(),
        reps: z.string().trim().max(20).nullable().optional(),
        weight: z.string().trim().max(40).nullable().optional(),
        restSec: z.int().nonnegative().max(3600).nullable().optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .max(50),
});
export type PutPlanExercisesRequest = z.infer<typeof PutPlanExercisesRequest>;

// ---------------------------------------------------------------- documents (trainer only)

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

export const Document = z.object({
  id: Id,
  clientId: Id,
  fileName: z.string(),
  mimeType: z.enum(DOCUMENT_MIME_TYPES),
  sizeBytes: z.int().positive(),
  confirmedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Document = z.infer<typeof Document>;

export const CreateDocumentRequest = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(DOCUMENT_MIME_TYPES),
  sizeBytes: z.int().positive().max(DOCUMENT_MAX_BYTES, 'Files can be at most 20 MB'),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequest>;

/** Presigned PUT, valid 5 min. The client must send the same Content-Type. */
export const CreateDocumentResponse = z.object({
  documentId: Id,
  uploadUrl: z.url(),
  expiresAt: IsoDateTime,
});
export type CreateDocumentResponse = z.infer<typeof CreateDocumentResponse>;

/** Presigned GET, valid 60 s. */
export const DocumentDownloadResponse = z.object({ url: z.url(), expiresAt: IsoDateTime });
export type DocumentDownloadResponse = z.infer<typeof DocumentDownloadResponse>;

// ---------------------------------------------------------------- calendar feed

export const CalendarFeedResponse = z.object({ url: z.url() });
export type CalendarFeedResponse = z.infer<typeof CalendarFeedResponse>;
export const CalendarFeedParams = z.object({ token: z.string().min(16).max(128) });
