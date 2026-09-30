import { z } from 'zod';
import { Id, IsoDateTime, PersonSummary } from './common';
import { Package } from './packages';

/** Client list flags (SPEC §4): Unpaid · ≤ 2 left · expires in ≤ 5 days · no active package. */
export const ClientFlag = z.enum(['UNPAID', 'LOW', 'EXPIRING', 'NO_PACKAGE']);
export type ClientFlag = z.infer<typeof ClientFlag>;

export const ClientListItem = PersonSummary.extend({
  phone: z.string().nullable(),
  joinedAt: IsoDateTime,
  archived: z.boolean(),
  activePackage: Package.nullable(),
  nextPractice: z.object({ id: Id, startsAt: IsoDateTime }).nullable(),
  flags: z.array(ClientFlag),
});
export type ClientListItem = z.infer<typeof ClientListItem>;

export const ClientsQuery = z.object({
  flag: ClientFlag.optional(),
  q: z.string().trim().max(80).optional(),
  includeArchived: z.stringbool().optional(),
});
export type ClientsQuery = z.infer<typeof ClientsQuery>;

export const ClientDetail = ClientListItem.extend({
  email: z.email(),
  consentAt: IsoDateTime.nullable(),
  pinnedNote: z.object({ id: Id, body: z.string() }).nullable(),
});
export type ClientDetail = z.infer<typeof ClientDetail>;

export const UpdateClientRequest = z.object({ archived: z.boolean() });
export type UpdateClientRequest = z.infer<typeof UpdateClientRequest>;
