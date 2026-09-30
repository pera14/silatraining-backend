# calendar-feed module

**Owner:** Agent B (feat/content)

Implement (endpoint keys from `@sila/contracts` `endpoints`):

- trainer.calendarFeed.*
- calendarFeed.ics (public, token = deriveToken(JOIN_TOKEN_SECRET, "calendar", CalendarFeedToken.id))

Rules: validate with `bodyDto/queryDto/paramsDto(key)` (common/http/zod-dto), throw `DomainError(code)`,
check ownership in the service, decorate with `@Roles(...)` matching the endpoint's `access`.
