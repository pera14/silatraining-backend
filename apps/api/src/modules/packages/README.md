# packages module

**Owner:** Agent A (feat/scheduling)

Implement (endpoint keys from `@sila/contracts` `endpoints`):

- trainer.packages.*
- trainer.packageTypes.*
- trainer.clients.* (list with flags, detail, archive)
- client.packages
- use PackageUsageService (common/package-usage) for left/used

Rules: validate with `bodyDto/queryDto/paramsDto(key)` (common/http/zod-dto), throw `DomainError(code)`,
check ownership in the service, decorate with `@Roles(...)` matching the endpoint's `access`.
