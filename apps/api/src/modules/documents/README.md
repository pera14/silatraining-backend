# documents module

**Owner:** Agent B (feat/content)

Implement (endpoint keys from `@sila/contracts` `endpoints`):

- trainer.documents.*
- StorageService in common/storage (Agent B owns that folder)
- cron: purge soft-deleted objects after 30 days

Rules: validate with `bodyDto/queryDto/paramsDto(key)` (common/http/zod-dto), throw `DomainError(code)`,
check ownership in the service, decorate with `@Roles(...)` matching the endpoint's `access`.
