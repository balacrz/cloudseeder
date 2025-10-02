// lib/loader.js
/* Full loader resolution logic for config-driven mapping
 * - Constants interpolation: ${constants.Key}
 * - Template evaluation: "${Some.Field}" from the source record
 * - Shape: removeFields, defaults, fieldMap
 * - Transforms: pre/post (ops: assign, copy, rename, remove, coalesce, concat)
 * - References: declarative resolver (refKey/refObject/refKeyTemplate) + legacy idMaps.* support
 * - Batching + strategy: insert/upsert over rest/composite (bulk stub ready)
 * - NEW: Metadata validation (org-scoped cache under meta-data/<ORG_ID>/)
 */

import { log } from './utils/logger.js';

import {
  shapeRecord,
  applyTransforms,
  resolveConstantsDeep,
  assertRequiredFields
} from './utils.min.js';

import { resolveReferences } from './mapping/ref-solver.js';
import { commit } from './sf.js';

// ✅ metadata validator (org-aware; uses meta-data/<ORG_ID>/)
import {
  ensureObjectMetadataAvailable,
  loadObjectDescribeFromCache,
  toFieldMap,
  pruneRecordFields,
  validateBatch
} from './metadata.min.js';

// ---------- helpers ----------
function chunk(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}
function get(obj, path) {
  return String(path || '')
    .split('.')
    .reduce((o, p) => (o ? o[p] : undefined), obj);
}
function computeUniqKey(rec, fields = []) {
  return fields.map((f) => JSON.stringify(get(rec, f))).join('|');
}

/**
 * Main entry: insert/upsert records per object mapping.
 * @param {jsforce.Connection} conn
 * @param {string} objectName
 * @param {Array<Object>} records - raw records from data file or generator
 * @param {Object} cfg - mapping config for this object
 * @param {Object} idMaps - accumulated id maps from previous steps
 * @param {Object} constants - constants object (already loaded), optional
 * @returns {Promise<Object>} idMap keyed by cfg.identify.matchKey
 */
export async function insertAndMap(conn, objectName, records, cfg, idMaps = {}, constants = {}) {
  const matchKey = cfg?.identify?.matchKey;
  if (!matchKey) {
    log.error(objectName, `❌ Missing identify.matchKey`);
    throw new Error(`Mapping for ${objectName} missing identify.matchKey`);
  }

  // 1) constants into config (so defaults, transforms can use ${constants.*})
  const cfgResolved = resolveConstantsDeep(cfg, constants);

  // Strategy & validation guards
  const pre = cfgResolved?.transform?.pre || [];
  const post = cfgResolved?.transform?.post || [];
  const req = cfgResolved?.validate?.requiredFields || [];
  const uniqBy = cfgResolved?.validate?.uniqueBy || [];
  const strategy = cfgResolved?.strategy || { operation: 'insert', api: 'rest' };
  const op = String(strategy.operation || 'insert').toLowerCase();

  // ✅ 0) Metadata availability + load (before any per-record assertions)
  //    Ensures meta-data/<ORG_ID>/<Object>.json exists; instructs to refresh if missing.
  await ensureObjectMetadataAvailable(objectName);
  const describe = await loadObjectDescribeFromCache(objectName);
  const fieldMap = toFieldMap(describe);

  // 2) shape + transforms + references (build working set; defer required-field assert)
  const transformedRecord = records.map((r) => {
    let rec = { ...r };

    // constants in record values (e.g., seed data with ${constants.*})
    rec = resolveConstantsDeep(rec, constants);

    // pre transforms (on raw+constants)
    rec = applyTransforms(rec, pre);

    // shape the record (defaults, fieldMap, removeFields)
    rec = shapeRecord(rec, cfgResolved);

    // 🔗 resolve references (declarative + legacy); pass objectName for ParentId self-ref
    rec = resolveReferences(rec, cfgResolved?.references || [], idMaps, objectName);

    // post transforms (e.g., cleanup fields after refs)
    rec = applyTransforms(rec, post);

    // (no assertRequiredFields here — we first validate against metadata)
    return rec;
  });
  
  // ✅ 4) Pruning
  // prune unknown (and optionally not-writeable) fields before validating
  const pruneUnknown = true; // always remove fields that don’t exist in org
  const pruneNotWritable = true; // optional: also drop not-createable/updateable for this op

  // Build `work` as before (shape → refs → post transforms), then:
  const pruned = pruneRecordFields(objectName, transformedRecord, fieldMap, {
    operation: op,
    pruneUnknown: true,
    pruneNotWritable: true
  });

  // if you want a quick log to see what changed on first couple records:
  if (pruned.length && process.env.LOG_PRUNE === 'true') {
    const diff = (a, b) => Object.keys(a).filter(k => !(k in b));
    console.log(`[${objectName}] pruned fields (first 2):`,
      pruned.slice(0,2).map((r,i)=>({rec:i+1, removed: diff(work[i], r)})));
  }

  // ✅ 4) Field-level metadata validation BEFORE required field checks
  //     Prevents "No such column" / not-createable/updateable at source.
  validateBatch(objectName, pruned, fieldMap, { operation: op });

  // 5) record-level required validation (order matters: metadata first, then required fields)
  for (const rec of pruned) {
    assertRequiredFields(rec, req, `${objectName}:${get(rec, matchKey) ?? 'unknown'}`);
  }

  // 6) optional uniqueness guard (client-side)
  if (uniqBy.length > 0) {
    const seen = new Set();
    for (const rec of pruned) {
      const uk = computeUniqKey(rec, uniqBy);
      if (seen.has(uk)) {
        throw new Error(
          `Uniqueness violated for ${objectName}: fields [${uniqBy.join(', ')}], key=${uk}`
        );
      }
      seen.add(uk);
    }
  }

  console.log(pruned);

  const idMap = {};
  // 7) batching & commit
  const batchSize = cfgResolved?.strategy?.batchSize || 200;
  const batches = chunk(pruned, batchSize);

  // 🔊 OPERATION START
  log.info(objectName, `No of DML rows: ${records?.length ?? 0}`);
  log.info(objectName, `Built ${pruned.length} records ready for ${strategy.operation}`);

  for (const batch of batches) {
    // 🔒 await commit so downstream steps see fresh idMaps
    const results = await commit(conn, objectName, batch, strategy);
    let processedRecords = [];
    if(results.failures.length > 0){
      log.info(objectName, `Commit ERROR ${objectName} : ${results.failures}`);
    }else{
      processedRecords = results.processedRecords;
    }

    // Normalize results into array if a single object
    const arr = Array.isArray(processedRecords) ? processedRecords : [processedRecords];

    if(strategy.operation === 'upsert'){
      const extField = strategy.externalIdField;
      arr.forEach((rec) => {
        const sid = rec.Id || rec.id || rec.upsertedId || (rec[0] && rec[0].id);
        const key = rec[extField];

        if (sid && key) {
          idMap[key] = sid;   // ✅ keep this important mapping
        } else {
          const msg = JSON.stringify(rec?.errors || rec || {});
          log.info(objectName, `ERROR ${objectName} [${key ?? 'UNKNOWN'}]: ${msg}`);
        }
      });

    }
    else{
      arr.forEach((res, i) => {
        const key = get(batch[i], matchKey);
        if (res && (res.success === true || res.id || res.upsertedId)) {
          const sid = res.id || res.upsertedId || (res[0] && res[0].id);
          if (sid) idMap[key] = sid;
        } else {
          const msg = JSON.stringify(res?.errors || res || {});
          log.info(objectName, `ERROR ${objectName} [${key}]: ${msg}`);
        }
      });
    }
  }

  return idMap;
}
