# calendar-feed module

**Owner:** Agent B (feat/content) · endpoints `trainer.calendarFeed.*`, `calendarFeed.ics`

Per-trainer iCal feed: `GET /trainer/calendar-feed` returns `${API_URL}/calendar/<token>.ics` (created on first
call), `POST …/regenerate` revokes it. Token = `HMAC(JOIN_TOKEN_SECRET, "calendar:<rowId>")`, only `sha256(token)` is
stored, one active row per trainer (`calendar_feed_one_active`). The `.ics` route is public (the token is the
credential); unknown/revoked tokens are 404. It lists non-cancelled practices from 60 days back to 180 days ahead as
UTC instants, with only the client's name and plan (no notes, packages or documents: the URL ends up in third-party
calendar apps).
