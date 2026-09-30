# sessions module

**Owner:** Agent A (feat/scheduling)

Implement (endpoint keys from `@sila/contracts` `endpoints`):

- trainer.sessions.*
- trainer.today
- client.home
- client.sessions.*
- cron: nightly auto-mark BOOKED -> ATTENDED
- emit EVENTS.sessionBooked / sessionCancelled / sessionMoved (common/events)

Rules: validate with `bodyDto/queryDto/paramsDto(key)` (common/http/zod-dto), throw `DomainError(code)`,
check ownership in the service, decorate with `@Roles(...)` matching the endpoint's `access`.
