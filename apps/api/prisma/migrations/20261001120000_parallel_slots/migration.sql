-- Parallel slots: a trainer can run two clients at once (08:00-09:00 + 08:00-09:00, or + 08:30-09:30).
-- Regular slots still never overlap each other (DB-enforced, and the series cron relies on it through
-- INSERT ... ON CONFLICT DO NOTHING). A parallel slot may overlap other slots; the API caps how many run at
-- once (MAX_PARALLEL_SLOTS) under a per-trainer advisory lock, because a constraint cannot count overlaps.

ALTER TABLE "Slot" ADD COLUMN "parallel" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Slot" DROP CONSTRAINT slot_no_overlap;
ALTER TABLE "Slot" ADD CONSTRAINT slot_no_overlap
  EXCLUDE USING gist ("trainerId" WITH =, tstzrange("startsAt", "endsAt") WITH &&) WHERE (NOT "parallel");
