import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  type ClientJoinedEvent,
  EVENTS,
  type SessionBookedEvent,
  type SessionCancelledEvent,
  type SessionMovedEvent,
} from '../../common/events/events';
import { NotificationsService } from './notifications.service';

/**
 * Domain events → emails. Producers (join, Agent A's booking) only emit after their transaction commits; handlers
 * run async so a slow SMTP server never delays an HTTP response, and never throw.
 */
@Injectable()
export class NotificationsListener {
  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent(EVENTS.clientJoined, { async: true })
  onClientJoined(e: ClientJoinedEvent): Promise<void> {
    return this.notifications.safely('welcome email', () => this.notifications.onClientJoined(e));
  }

  @OnEvent(EVENTS.sessionBooked, { async: true })
  onSessionBooked(e: SessionBookedEvent): Promise<void> {
    return this.notifications.safely('booking email', () => this.notifications.onSessionBooked(e));
  }

  @OnEvent(EVENTS.sessionCancelled, { async: true })
  onSessionCancelled(e: SessionCancelledEvent): Promise<void> {
    return this.notifications.safely('cancellation email', () =>
      this.notifications.onSessionCancelled(e),
    );
  }

  @OnEvent(EVENTS.sessionMoved, { async: true })
  onSessionMoved(e: SessionMovedEvent): Promise<void> {
    return this.notifications.safely('moved email', () => this.notifications.onSessionMoved(e));
  }
}
