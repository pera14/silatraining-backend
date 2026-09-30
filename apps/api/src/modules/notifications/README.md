# notifications module

**Owner:** Agent B (feat/content)

Implement (endpoint keys from `@sila/contracts` `endpoints`):

- @OnEvent listeners for EVENTS.* (common/events)
- welcome, booking confirmed, cancelled, 24h reminder (cron every 15 min, reminderSentAt), package expiring (NotificationLog)

Rules: validate with `bodyDto/queryDto/paramsDto(key)` (common/http/zod-dto), throw `DomainError(code)`,
check ownership in the service, decorate with `@Roles(...)` matching the endpoint's `access`.
