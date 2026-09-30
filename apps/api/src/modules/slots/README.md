# slots module

**Owner:** Agent A (feat/scheduling)

Implement (endpoint keys from `@sila/contracts` `endpoints`):

- trainer.slots.*
- trainer.slotSeries.*
- trainer.calendar
- client.slots
- cron: materialize series SLOT_HORIZON_WEEKS ahead
- cron: autoBook reserved series

Rules: validate with `bodyDto/queryDto/paramsDto(key)` (common/http/zod-dto), throw `DomainError(code)`,
check ownership in the service, decorate with `@Roles(...)` matching the endpoint's `access`.
