import { Injectable } from '@nestjs/common';

/**
 * The current instant. Every scheduling rule that depends on "now" (6h cutoffs, upcoming/past, crons) reads it
 * from here, so e2e tests can pin time exactly (e.g. 5:59 vs 6:00 before a practice).
 */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
