import { Injectable } from '@nestjs/common';
import type { ClientDetail, ClientListItem, EndpointBody, EndpointQuery } from '@sila/contracts';
import { toPersonSummary } from '../../common/http/mappers';
import { OwnershipService } from '../../common/ownership/ownership.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { localDay } from '../../common/time/time';
import { AppConfig } from '../../config/app-config.service';
import type { Prisma } from '../../generated/prisma/client';
import { Clock } from '../sessions/clock';
import { clientFlags, pickActivePackage } from './client-flags';
import { toPackageFacts } from './package-mappers';
import { PackagesService } from './packages.service';

const LINK_INCLUDE = { client: true } satisfies Prisma.TrainerClientInclude;
type LinkRow = Prisma.TrainerClientGetPayload<{ include: typeof LINK_INCLUDE }>;

/** The trainer's Clients tab: list with package numbers + flags, detail, archive (SPEC §4/§5). */
@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly packages: PackagesService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async list(
    trainerId: string,
    query: EndpointQuery<'trainer.clients.list'>,
  ): Promise<ClientListItem[]> {
    // Every word must match the first name, last name, email or phone ("ana petr" finds Ana Petrović).
    const words = (query.q ?? '').split(/\s+/).filter(Boolean);
    const links = await this.prisma.trainerClient.findMany({
      where: {
        trainerId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
        client: {
          AND: words.map((w) => ({
            OR: (['firstName', 'lastName', 'email', 'phone'] as const).map((field) => ({
              [field]: { contains: w, mode: 'insensitive' as const },
            })),
          })),
        },
      },
      include: LINK_INCLUDE,
    });
    const items = await this.build(links);
    return items
      .filter((i) => !query.flag || i.flags.includes(query.flag))
      .sort(
        (a, b) =>
          a.firstName.localeCompare(b.firstName, 'sr') ||
          a.lastName.localeCompare(b.lastName, 'sr'),
      );
  }

  async get(trainerId: string, clientId: string): Promise<ClientDetail> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const link = await this.prisma.trainerClient.findUniqueOrThrow({
      where: { clientId },
      include: LINK_INCLUDE,
    });
    const [[item], note] = await Promise.all([
      this.build([link]),
      this.prisma.clientNote.findFirst({
        where: { clientId, trainerId, pinned: true },
        select: { id: true, body: true },
      }),
    ]);
    return {
      ...item!,
      email: link.client.email,
      consentAt: link.client.consentAt?.toISOString() ?? null,
      pinnedNote: note,
    };
  }

  /** Archive / unarchive. Archived clients disappear from the list and cannot book. */
  async update(
    trainerId: string,
    clientId: string,
    body: EndpointBody<'trainer.clients.update'>,
  ): Promise<ClientDetail> {
    await this.ownership.assertTrainerOwnsClient(trainerId, clientId, { includeArchived: true });
    const link = await this.prisma.trainerClient.findUniqueOrThrow({ where: { clientId } });
    const archivedAt = body.archived ? (link.archivedAt ?? this.clock.now()) : null;
    await this.prisma.trainerClient.update({ where: { clientId }, data: { archivedAt } });
    return this.get(trainerId, clientId);
  }

  /** Three queries for any number of clients: packages (+ usage view), next practices. */
  private async build(links: LinkRow[]): Promise<ClientListItem[]> {
    if (links.length === 0) return [];
    const clientIds = links.map((l) => l.clientId);
    const now = this.clock.now();
    const today = localDay(now, this.config.timezone);

    const [packageRows, upcoming] = await Promise.all([
      this.prisma.package.findMany({ where: { clientId: { in: clientIds } } }),
      this.prisma.session.findMany({
        where: { clientId: { in: clientIds }, status: 'BOOKED', startsAt: { gt: now } },
        orderBy: { startsAt: 'asc' },
        select: { id: true, clientId: true, startsAt: true },
      }),
    ]);
    const packages = await this.packages.present(packageRows);

    const nextByClient = new Map<string, { id: string; startsAt: string }>();
    for (const s of upcoming) {
      if (!nextByClient.has(s.clientId)) {
        nextByClient.set(s.clientId, { id: s.id, startsAt: s.startsAt.toISOString() });
      }
    }

    return links.map((link) => {
      const own = packages.filter((p) => p.clientId === link.clientId);
      const facts = own.map(toPackageFacts);
      const active = pickActivePackage(facts, today);
      return {
        ...toPersonSummary(link.client),
        phone: link.client.phone,
        joinedAt: link.joinedAt.toISOString(),
        archived: !!link.archivedAt,
        activePackage: active ? own.find((p) => p.id === active.id)! : null,
        nextPractice: nextByClient.get(link.clientId) ?? null,
        flags: clientFlags(facts, today),
      };
    });
  }
}
