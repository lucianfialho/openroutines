/**
 * Minimal subprocess environments.
 *
 * The orchestrator process holds every secret from .env (GITHUB_TOKEN,
 * KIMI_API_KEY, DATABASE_URL, GITHUB_WEBHOOK_SECRET, ...). Child processes must
 * receive only the vars they actually need, so a command derived from untrusted
 * card/issue text can never echo a secret it was never given.
 */

export type ProcessEnv = Record<string, string>;

/** Vars every subprocess needs to locate binaries and a home directory. */
export const BASE_ENV_VARS = ["PATH", "HOME"] as const;

/** Return an env containing only the named vars that are actually set. */
export const pickEnv = (names: readonly string[]): ProcessEnv => {
  const env: ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};
