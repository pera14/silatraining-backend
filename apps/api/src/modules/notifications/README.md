# notifications module

**Owner:** Agent B (feat/content) · no HTTP endpoints

Emails are bilingual (Serbian Latin first, English below), branded with the SILA mark from
`${APP_URL}/brand/sila-mark.png`. Copy lives in `templates.ts` (pure, unit-tested); layout in `email-layout.ts`.

| Trigger                                  | Recipient | Notes                                                                       |
| ---------------------------------------- | --------- | --------------------------------------------------------------------------- |
| `client.joined`                          | client    | welcome; once per trainer+client (`NotificationLog` `client.welcome`)       |
| `session.booked` (client/trainer/system) | client    | booking confirmed                                                           |
| `session.cancelled` by CLIENT            | trainer   | says whether the practice went back to the package                          |
| `session.cancelled` by TRAINER           | client    | returned / counts as used (nothing about packages if booked without one)    |
| `session.moved`                          | client    | old → new time; re-arms the 24 h reminder                                   |
| cron every 15 min                        | client    | 24 h reminder, claimed atomically via `Session.reminderSentAt`              |
| cron daily 08:00 Europe/Belgrade         | trainer   | digest of packages ending within 5 days with practices left, active clients |

Rules: handlers run after the producer's commit, asynchronously, and never throw. Practices already in the past get no
email. A booking/move landing inside the 24 h window marks the reminder as sent (its own email carries the time).
Failed sends release their claim (reminder / `NotificationLog`) so the next run retries. The expiring digest logs each
package per end date (`package.expiring`, `<packageId>:<effectiveUntil>`), so an extended package is announced again.
`Clock` comes from SessionsModule so e2e tests pin "now" for booking and notifications together.
