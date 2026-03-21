import fs from "fs";
import JSON5 from "json5";

/**
 * Read a file and parse it with JSON5 (permissive: comments, trailing commas).
 * Strips a leading BOM if present.
 *
 * @param {string} filePath
 * @returns {*}
 */
export function readJSON(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""); // strip BOM
  return JSON5.parse(raw);
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Recursively merge two plain objects. Arrays are replaced, not concatenated.
 * Neither argument is mutated; returns a new object.
 *
 * @param {*} target
 * @param {*} source
 * @returns {*}
 */
function deepMergePair(target, source) {
  if (source === undefined || source === null) return structuredClone(target) ?? {};
  if (Array.isArray(target) && Array.isArray(source)) return [...source];
  if (isPlainObject(target) && isPlainObject(source)) {
    const out = { ...target };
    for (const [k, v] of Object.entries(source)) {
      out[k] = deepMergePair(out[k], v);
    }
    return out;
  }
  // Primitives or mismatched types — source wins
  return structuredClone(source);
}

/**
 * Deep-merge any number of objects, left to right.
 * Arrays are replaced (not concatenated). Returns a new object; inputs are not mutated.
 *
 * Callers that previously passed a fresh `{}` as the first argument (e.g., `deepMerge({}, base, env)`)
 * continue to work correctly — the result is always a new object with no shared references.
 *
 * @param {object}    target
 * @param {...object} sources
 * @returns {object}
 */
export function deepMerge(target, ...sources) {
  return sources.reduce(deepMergePair, structuredClone(target) ?? {});
}
