/**
 * Plan rotation (SPEC §4, as confirmed with the trainer): a new practice gets the plan that follows the plan of
 * the client's previous non-cancelled practice, wrapping around by `sortOrder` (A → B → A). Attendance does not
 * matter; the plan only tells the trainer what to show that day.
 *
 * `plans` must be the client's active plans already sorted by rotation order.
 */
export function nextPlanId(
  plans: ReadonlyArray<{ id: string }>,
  previousPlanId: string | null,
): string | null {
  if (plans.length === 0) return null;
  const idx = previousPlanId ? plans.findIndex((p) => p.id === previousPlanId) : -1;
  // No history, or the previous plan was archived/removed: start the rotation from the first plan.
  if (idx === -1) return plans[0]!.id;
  return plans[(idx + 1) % plans.length]!.id;
}
