/**
 * Domain events (@nestjs/event-emitter). Producers only emit; consumers (notifications, Agent B) listen.
 * ADDITIVE ONLY during the parallel phase: add a new name + payload, never change an existing one.
 *
 *   this.events.emit(EVENTS.sessionBooked, payload satisfies SessionBookedEvent);
 *   @OnEvent(EVENTS.sessionBooked) handle(e: SessionBookedEvent) {}
 */
export const EVENTS = {
  clientJoined: 'client.joined',
  sessionBooked: 'session.booked',
  sessionCancelled: 'session.cancelled',
  sessionMoved: 'session.moved',
} as const;

export interface ClientJoinedEvent {
  clientId: string;
  trainerId: string;
  via: 'register' | 'accept';
}

export interface SessionBookedEvent {
  sessionId: string;
  trainerId: string;
  clientId: string;
  startsAt: Date;
  bookedBy: 'CLIENT' | 'TRAINER' | 'SYSTEM';
}

export interface SessionCancelledEvent {
  sessionId: string;
  trainerId: string;
  clientId: string;
  startsAt: Date;
  cancelledBy: 'CLIENT' | 'TRAINER';
  practiceReturned: boolean;
}

export interface SessionMovedEvent {
  sessionId: string;
  trainerId: string;
  clientId: string;
  fromStartsAt: Date;
  toStartsAt: Date;
}
