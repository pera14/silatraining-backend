# exercises module

**Owner:** Agent B (feat/content)

Implemented (endpoint keys from `@sila/contracts` `endpoints`):

- trainer.exercises.*

Rules: validate with `bodyDto/queryDto/paramsDto(key)` (common/http/zod-dto), throw `DomainError(code)`,
check ownership in the service, decorate with `@Roles(...)` matching the endpoint's `access`.
