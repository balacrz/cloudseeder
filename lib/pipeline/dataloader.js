// lib/pipeline/dataloader.js
import path from 'path';
import { readJSON } from '../config/utils.js';

// Per-run file cache — avoids re-reading the same file for multiple steps
const _cache = Object.create(null);

/**
 * Load a data file (JSON5) relative to the project root.
 * Caches the parsed result so the same file is only read once per process.
 *
 * @param {string} absOrRel - absolute or root-relative file path
 * @param {string} cwd      - project root used to resolve relative paths
 * @returns {*} parsed file contents
 */
export function loadDataFile(absOrRel, cwd) {
  const filePath = path.isAbsolute(absOrRel) ? absOrRel : path.join(cwd, absOrRel);
  if (!_cache[filePath]) {
    _cache[filePath] = readJSON(filePath);
  }
  return _cache[filePath];
}
