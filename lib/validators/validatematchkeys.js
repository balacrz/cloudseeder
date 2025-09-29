// lib/validators/validateMatchKeys.js
import fs from "fs";
import path from "path";

/**
 * Read JSON (strict). If you store JSON5, swap to your readJSON() util.
 */
function readJSON(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  return JSON.parse(src);
}

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Extract match keys from a mapping/config object produced by loadStepConfig().
 * Supports string or array under identify.matchKey.
 */
function getMatchKeys(mappingCfg) {
  const raw = mappingCfg?.identify?.matchKey;
  return toArray(raw).map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Build a set of field API names from a Salesforce describe snapshot JSON.
 */
function buildFieldSetFromDescribe(describeJson) {
  const set = new Set();
  for (const f of describeJson.fields || []) set.add(f.name);
  return set;
}

/**
 * Read the describe snapshot saved by snapshotOrgMetadata() for an object.
 * We expect: <metaDir>/<orgId>/<Object>.json
 */
function readDescribeSnapshot({ metaDir, orgId, objectName }) {
  const filePath = path.join(metaDir, orgId, `${objectName}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Describe snapshot not found for ${objectName} at ${filePath}`);
  }
  return readJSON(filePath);
}

/**
 * Validate that each step's identify.matchKey exists in the saved snapshot.
 *
 * @param {Object} params
 * @param {Array}  params.steps            Topo-sorted steps
 * @param {String} params.metaDir          Base metadata dir (e.g., ../meta-data)
 * @param {String} params.orgId            Org Id used by snapshot
 * @param {Function} params.loadStepConfig Function(step, {envName, cwd, cache}) -> mapping config
 * @param {String} params.envName          Environment name (dev/qa/prod)
 * @param {String} params.cwd              Project root to resolve config paths
 */
export async function validateMatchKeysFromSnapshots({
  steps,
  metaDir,
  orgId,
  loadStepConfig,
  envName,
  cwd
}) {
  const errors = [];
  const warnings = [];
  const describeCache = new Map(); // objectName -> Set(fields)

  for (const step of steps) {
    const objectName = String(step.object || "").trim();
    if (!objectName) continue;

    // Load the mapping for this step exactly as runLoad does
    const mappingCfg = loadStepConfig(step, { envName, cwd, cache: true });

    // Pull identify.matchKey
    const matchKeys = getMatchKeys(mappingCfg);
    if (!matchKeys.length) {
      warnings.push({ object: objectName, message: "No identify.matchKey defined." });
      continue;
    }

    // Read/cached describe fields from snapshot
    let fieldSet = describeCache.get(objectName);
    if (!fieldSet) {
      const describeJson = readDescribeSnapshot({ metaDir, orgId, objectName });
      fieldSet = buildFieldSetFromDescribe(describeJson);
      describeCache.set(objectName, fieldSet);
    }

    // Validate each match key
    for (const key of matchKeys) {
      if (!fieldSet.has(key)) {
        errors.push({
          object: objectName,
          matchKey: key,
          message: `Match key '${key}' not found on ${objectName} (per snapshot).`
        });
      }
    }
  }

  // Report
  if (warnings.length) {
    console.warn("[MatchKey Validator] Warnings:");
    for (const w of warnings) console.warn(`  - ${w.object}: ${w.message}`);
  }

  if (errors.length) {
    const summary = errors.map(e => `• ${e.object}: '${e.matchKey}'`).join("\n");
    const err = new Error(`Match key validation failed — missing fields:\n${summary}`);
    err.details = errors;
    throw err;
  }

  console.log("[MatchKey Validator] All match keys exist ✅");
}
