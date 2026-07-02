/**
 * Timezone validation for boot.
 *
 * The whole system assumes America/Sao_Paulo — cron schedules like the 01:00
 * night run only make sense in that zone. node-cron falls back to the process
 * timezone when TZ is unset, so we warn (not block) at boot.
 */

export const EXPECTED_TZ = "America/Sao_Paulo";

/** Returns a warning string when TZ is not the expected zone, else null. */
export const timezoneWarning = (tz: string | undefined): string | null =>
  tz === EXPECTED_TZ
    ? null
    : `TZ is "${tz ?? "(unset)"}", expected "${EXPECTED_TZ}". Cron schedules (e.g. the 01:00 night run) assume this timezone — set TZ=${EXPECTED_TZ} in the environment.`;
