import type { Me, PersonSummary } from '@sila/contracts';
import type { User } from '../../generated/prisma/client';

type PersonFields = Pick<User, 'id' | 'firstName' | 'lastName' | 'photoUrl'>;

export function toPersonSummary(u: PersonFields): PersonSummary {
  return { id: u.id, firstName: u.firstName, lastName: u.lastName, photoUrl: u.photoUrl };
}

export function toMe(user: User, trainer: PersonFields | null): Me {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    photoUrl: user.photoUrl,
    consentAt: user.consentAt?.toISOString() ?? null,
    trainer: user.role === 'CLIENT' && trainer ? toPersonSummary(trainer) : null,
  };
}

export function fullName(u: Pick<User, 'firstName' | 'lastName'>): string {
  return `${u.firstName} ${u.lastName}`.trim();
}
