// lib/pipeline/generators.js
import { generators as legacyGenerators } from '../../services/generators.js';

/**
 * Dispatch to a named generator function from services/generators.js.
 *
 * @param {object} step    - pipeline step with a `generator` name
 * @param {*}      rawData - raw loaded data file contents
 * @param {object} idMaps  - accumulated id maps from prior steps
 * @returns {Array} generated records
 */
export function runGenerator(step, rawData, idMaps) {
  const name = step.generator;
  const fn = legacyGenerators && legacyGenerators[name];
  if (!fn) {
    throw new Error(
      `Unknown generator '${name}'. Add it to services/generators.js or adjust pipeline.`
    );
  }
  return fn(rawData, idMaps);
}
