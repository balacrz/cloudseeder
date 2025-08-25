/* Full loader resolution logic for config-driven mapping
 * - Constants interpolation: ${constants.Key}
 * - Template evaluation: "${Some.Field}" from the source record
 * - Shape: removeFields, defaults, fieldMap
 * - Transforms: pre/post (ops: assign, copy, rename, remove, coalesce, concat)
 * - References: resolve from idMaps via string templates
 * - Batching + strategy: insert/upsert over rest/composite (bulk stub ready)
 */
import { log } from './logger.js';
import { shapeRecord, applyTransforms, resolveReferences, resolveConstantsDeep, assertRequiredFields } from './utils.min.js';
import { commit } from './sf.js';

function chunk(arr, n) { const r = []; for (let i=0;i<arr.length;i+=n) r.push(arr.slice(i, i+n)); return r; }
function get(obj, path) { return path.split('.').reduce((o, p) => (o ? o[p] : undefined), obj); }

function computeUniqKey(rec, fields = []) {
  return fields.map(f => JSON.stringify(get(rec, f))).join('|');
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
  if (!matchKey){
    log.error(objectName, `❌ Missing identify.matchKey`);
    throw new Error(`Mapping for ${objectName} missing identify.matchKey`);
  } 

  // 1) constants into config (so defaults, transforms can use ${constants.*})
  const cfgResolved = resolveConstantsDeep(cfg, constants);

  // 2) shape + transforms + references + validate
  const pre = cfgResolved?.transform?.pre || [];
  const post = cfgResolved?.transform?.post || [];
  const req = cfgResolved?.validate?.requiredFields || [];
  const uniqBy = cfgResolved?.validate?.uniqueBy || [];

  
  // Build working set
  let work = records.map(r => {
    let rec = { ...r };

    // constants in record values (e.g., seed data with ${constants.*})
    rec = resolveConstantsDeep(rec, constants);

    rec = applyTransforms(rec, pre);
    rec = shapeRecord(rec, cfgResolved);
    rec = resolveReferences(rec, cfgResolved?.references || [], idMaps);
    rec = applyTransforms(rec, post);

    // record-level required validation
    assertRequiredFields(rec, req, `${objectName}:${get(rec, matchKey) ?? 'unknown'}`);
    return rec;
  });


  // optional uniqueness guard (client-side)
  if (uniqBy.length > 0) {
    const seen = new Set();
    for (const rec of work) {
      const uk = computeUniqKey(rec, uniqBy);
      if (seen.has(uk)) {
        throw new Error(`Uniqueness violated for ${objectName}: fields [${uniqBy.join(', ')}], key=${uk}`);
      }
      seen.add(uk);
    }
  }

  // 3) batching & commit
  const batchSize = cfgResolved?.strategy?.batchSize || 200;
  const strategy = cfgResolved?.strategy || { operation: 'insert', api: 'rest' };
  const batches = chunk(work, batchSize);

  
  // 🔊 STEP START
  log.stepStart(objectName, { mode: strategy.operation, api: strategy.api, batchSize });
  log.info(objectName, `No of DML rows: ${records?.length ?? 0}`);
  log.info(objectName, `Built ${work.length} records ready for ${strategy.operation}`);
  const idMap = {};
  for (const batch of batches) {
    const results = await commit(conn, objectName, batch, strategy);
    // Normalize results into array if a single object
    const arr = Array.isArray(results) ? results : [results];

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

  return idMap;
}
