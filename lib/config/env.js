// lib/config/env.js
/**
 * Centralized environment variable reader and validator.
 *
 * Call loadEnvConfig() once at startup (after dotenv has loaded .env).
 * All other modules receive config values as function arguments — they must
 * not read process.env directly.
 */

/**
 * Read, validate, and return all environment configuration as a typed object.
 * Throws at startup with a clear message listing every missing required variable.
 *
 * @returns {{ salesforce: object, loader: object }}
 */
export function loadEnvConfig() {
  const required = ['SF_LOGIN_URL', 'SF_USERNAME', 'SF_PASSWORD'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  return {
    salesforce: {
      loginUrl: process.env.SF_LOGIN_URL,
      username: process.env.SF_USERNAME,
      password: process.env.SF_PASSWORD,
    },
    loader: {
      envName:           process.env.LOADER_ENV || process.env.NODE_ENV || 'dev',
      dryRun:            process.env.DRY_RUN === 'true',
      refreshMetadata:   process.env.REFRESH_METADATA === 'true',
      autoCreateKeys:    process.env.AUTO_CREATE_MATCH_KEYS === 'true',
      logLevel:          process.env.LOG_LEVEL || 'info',
      logPrune:          process.env.LOG_PRUNE === 'true',
      debugRefs:         process.env.DEBUG_REFS === 'true',
      metaConcurrency:   Number(process.env.META_CONCURRENCY || 2),
    },
  };
}
