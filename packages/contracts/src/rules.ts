/** Business constants shared by API and web (SPEC §1 "Key rules"). The API may override via env. */
export const RULES = {
  practiceMinutes: 60,
  bookingCutoffHours: 6,
  cancelCutoffHours: 6,
  standardPracticesPerPackage: 10,
  /** Extension limit: validFrom + 5 weeks − 1 day. */
  maxExtensionWeeks: 5,
  lowPracticesThreshold: 2,
  expiringWithinDays: 5,
  timezone: 'Europe/Belgrade',
} as const;
