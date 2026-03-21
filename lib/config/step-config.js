// lib/config/step-config.js
import fs from 'fs';
import path from 'path';
import { readJSON, deepMerge } from './utils.js';

/**
 * Custom error for step config loading issues.
 */
export class StepConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StepConfigError';
  }
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

const CACHE = new Map();

/**
 * Load the object mapping/config for a single pipeline step.
 *
 * Merge order (low -> high precedence):
 *   1) base:   <baseDir>/<Object>.json            (optional)
 *   2) env:    <envDir>/<envName>/<Object>.json   (optional)
 *   3) step:   step.configFile                    (required)
 *   4) inline: step.configInline                  (optional)
 *
 * @param {object} step
 * @param {string} step.object          - API name (e.g., "Account", "Product2")
 * @param {string} step.configFile      - Path to the step-specific JSON file (required)
 * @param {object} [step.configInline]  - Inline overrides (optional)
 *
 * @param {object} [options]
 * @param {string} [options.baseDir]    - Directory containing base object JSONs (default: "<cwd>/config/base")
 * @param {string} [options.envDir]     - Directory containing env subfolders (default: "<cwd>/config/env")
 * @param {string} [options.envName]    - Environment name (default: process.env.NODE_ENV || "development")
 * @param {string} [options.cwd]        - Working directory used to resolve relative paths (default: process.cwd())
 * @param {boolean}[options.cache=true] - Enable memoization
 *
 * @returns {object} merged config object
 */
export function loadStepConfig(step, options = {}) {
  if (!isPlainObject(step)) {
    throw new StepConfigError('loadStepConfig(step) requires a step object.');
  }
  const { object: objectName, configFile, configInline } = step;
  if (!objectName) {
    throw new StepConfigError('loadStepConfig(step): step.object is required.');
  }
  if (!configFile) {
    throw new StepConfigError(`loadStepConfig(step): step.configFile is required for ${objectName}.`);
  }

  const {
    cwd = process.cwd(),
    baseDir = path.resolve(cwd, 'config', 'base'),
    envDir = path.resolve(cwd, 'config', 'env'),
    envName = process.env.NODE_ENV || 'development',
    cache = true,
  } = options;

  const absoluteStepPath = path.isAbsolute(configFile)
    ? configFile
    : path.resolve(cwd, configFile);

  const cacheKey = cache
    ? JSON.stringify({
        objectName,
        absoluteStepPath,
        envName,
        inlineHash: configInline ? stableInlineHash(configInline) : '',
        baseDir,
        envDir,
      })
    : null;

  if (cache && CACHE.has(cacheKey)) {
    return CACHE.get(cacheKey);
  }

  let merged = {};

  // 1) base config (optional)
  const basePath = path.join(baseDir, `${objectName}.json`);
  if (fs.existsSync(basePath)) {
    merged = deepMerge(merged, readJSON(basePath));
  }

  // 2) env overlay (optional)
  const envPath = path.join(envDir, envName, `${objectName}.json`);
  if (fs.existsSync(envPath)) {
    merged = deepMerge(merged, readJSON(envPath));
  }

  // 3) step config (required)
  if (!fs.existsSync(absoluteStepPath)) {
    throw new StepConfigError(
      `loadStepConfig(step): step.configFile not found for ${objectName}: ${absoluteStepPath}`
    );
  }
  merged = deepMerge(merged, readJSON(absoluteStepPath));

  // 4) inline overrides (optional)
  if (configInline && isPlainObject(configInline)) {
    merged = deepMerge(merged, configInline);
  }

  // minimal sanity check
  if (!isPlainObject(merged)) {
    throw new StepConfigError(`loadStepConfig(step): resolved config for ${objectName} is empty or invalid.`);
  }

  if (cache) CACHE.set(cacheKey, merged);
  return merged;
}

function stableInlineHash(obj) {
  // Simple deterministic JSON stringify for cache key creation
  return JSON.stringify(obj, Object.keys(obj).sort());
}

export default loadStepConfig;
