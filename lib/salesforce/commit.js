// lib/salesforce/commit.js
import { log } from '../utils/logger.js';

/** Strategy committers (REST & Composite; Bulk 2.0) */
async function commitREST(conn, objectName, batch, strategy) {
  // --- helpers --------------------------------------------------------------
  const normalizeResults = (res) => (Array.isArray(res) ? res : [res]);
  const toMessages = (errs) => {
    if (!errs) return [];
    if (Array.isArray(errs)) return errs.map(e => e?.message || e?.errorCode || JSON.stringify(e));
    return [errs.message || errs.errorCode || JSON.stringify(errs)];
  };
  const getKey = (row, extField, fallback, i) =>
    row?.[extField] ?? row?.Id ?? fallback ?? `row#${i}`;

  // --- INSERT path ----------------------------------------------------------
  if (strategy.operation !== 'upsert') {
    const insertRes = await conn.sobject(objectName).insert(batch);
    return {
      operation: 'insert',
      results: normalizeResults(insertRes),
      created: normalizeResults(insertRes)
        .filter(r => r?.success)
        .map((r, i) => ({ index: i, id: r.id })),
      failures: normalizeResults(insertRes)
        .filter(r => r && r.success === false)
        .map((r, i) => ({ index: i, id: r.id, messages: toMessages(r.errors) })),
    };
  }

  // --- UPSERT path ----------------------------------------------------------
  const externalIdField = strategy.externalIdField;
  if (!externalIdField) throw new Error('Missing strategy.externalIdField for upsert');

  for (let i = 0; i < batch.length; i++) {
    if (!batch[i][externalIdField]) {
      throw new Error(`Missing ${externalIdField} just before upsert for ${objectName} row#${i}`);
    }
  }

  const raw = await conn.sobject(objectName).upsert(batch, externalIdField);
  const results = normalizeResults(raw);

  const created = [];
  const updated = [];
  const failures = [];

  for (let i = 0; i < batch.length; i++) {
    const inRec = batch[i];
    const r = results[i];

    if (!r) {
      failures.push({
        index: i,
        key: getKey(inRec, externalIdField, null, i),
        id: undefined,
        messages: ['No result returned for this row'],
      });
      continue;
    }

    if (r.success === true) {
      const entry = {
        index: i,
        key: getKey(inRec, externalIdField, r.id, i),
        id: r.id,
        externalId: inRec[externalIdField],
      };
      if (r.created) created.push(entry);
      else updated.push(entry);
    } else {
      failures.push({
        index: i,
        key: getKey(inRec, externalIdField, r.id, i),
        id: r.id,
        externalId: inRec[externalIdField],
        messages: toMessages(r.errors).length ? toMessages(r.errors) : ['Unknown failure shape', JSON.stringify(r)],
      });
    }
  }

  const verifyExternalIds = [...created, ...updated]
    .map(e => e.externalId)
    .filter(Boolean);

  let processedRecords = [];
  if (verifyExternalIds.length > 0) {
    processedRecords = await conn.sobject(objectName)
      .find({ [externalIdField]: { $in: verifyExternalIds } }, `Id,${externalIdField}`);
  }

  if (created.length) log.info("COMMIT", `[${objectName}] Created: ${created.length}`);
  if (updated.length) log.info("COMMIT", `[${objectName}] Updated: ${updated.length}`);
  if (failures.length) {
    log.error("COMMIT", `[${objectName}] Failures: ${failures.length}`);
    for (const f of failures) {
      log.error("COMMIT", `  x row#${f.index} [${f.key}] -> ${f.id ?? 'n/a'}`);
      for (const m of f.messages) log.error("COMMIT", `     - ${m}`);
    }
  }

  return {
    operation: 'upsert',
    externalIdField,
    results,
    created,
    updated,
    failures,
    processedRecords,
  };
}


async function commitComposite(conn, objectName, batch, strategy) {
  // Minimal composite: fallback to sequential per-record REST calls (works with jsforce).
  // Replace with a true Composite request if you want single-call semantics.
  const op = strategy.operation || 'insert';
  const externalIdField = strategy.externalIdField || null;

  const created = [];
  const updated = [];
  const failures = [];

  for (let i = 0; i < batch.length; i++) {
    const rec = batch[i];
    try {
      let res;
      if (op === 'upsert') {
        res = await conn.sobject(objectName).upsert(rec, externalIdField);
      } else {
        res = await conn.sobject(objectName).insert(rec);
      }
      const r = Array.isArray(res) ? res[0] : res;
      if (r?.success) {
        const entry = {
          index: i,
          key: (externalIdField && rec[externalIdField]) ?? rec.Id ?? `row#${i}`,
          id: r.id,
          externalId: externalIdField ? rec[externalIdField] : undefined,
        };
        if (r.created) created.push(entry);
        else updated.push(entry);
      } else {
        failures.push({
          index: i,
          key: (externalIdField && rec[externalIdField]) ?? `row#${i}`,
          id: r?.id,
          externalId: externalIdField ? rec[externalIdField] : undefined,
          messages: [r?.errors?.[0]?.message || r?.errors?.[0]?.errorCode || 'Unknown failure'],
        });
      }
    } catch (e) {
      failures.push({
        index: i,
        key: (externalIdField && rec[externalIdField]) ?? `row#${i}`,
        id: undefined,
        externalId: externalIdField ? rec[externalIdField] : undefined,
        messages: [e.message],
      });
    }
  }

  if (created.length) log.info('COMMIT', `[${objectName}] Created: ${created.length}`);
  if (updated.length) log.info('COMMIT', `[${objectName}] Updated: ${updated.length}`);
  if (failures.length) {
    log.error('COMMIT', `[${objectName}] Failures: ${failures.length}`);
    for (const f of failures) {
      log.error('COMMIT', `  x row#${f.index} [${f.key}] -> ${f.id ?? 'n/a'}`);
      for (const m of f.messages) log.error('COMMIT', `     - ${m}`);
    }
  }

  return {
    operation: op,
    externalIdField,
    created,
    updated,
    failures,
    processedRecords: [],
  };
}


async function commitBulk(conn, objectName, batch, strategy) {
  // --- helpers --------------------------------------------------------------
  const toMsgs = (errs) => Array.isArray(errs)
    ? errs.map(e => e?.message || e?.errorCode || String(e))
    : (errs ? [String(errs)] : []);

  const getKey = (row, extField, fallback, i) =>
    (extField && row?.[extField]) || row?.Id || fallback || `row#${i}`;

  const firstNonEmpty = (...vals) => {
    for (const v of vals) if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    return undefined;
  };

  // --- operation & guards ---------------------------------------------------
  const op = (strategy.operation || '').toLowerCase();
  if (!['insert', 'upsert'].includes(op)) {
    throw new Error(`Bulk API implemented for insert|upsert only. Got: ${strategy.operation}`);
  }
  const externalIdField =
    op === 'upsert' ? (strategy.externalIdField || strategy.externalIdFieldName) : null;

  if (op === 'upsert' && !externalIdField) {
    throw new Error('Missing strategy.externalIdField for bulk upsert');
  }
  if (op === 'upsert') {
    for (let i = 0; i < batch.length; i++) {
      if (!batch[i] || !String(batch[i][externalIdField] ?? '').trim()) {
        throw new Error(`Missing ${externalIdField} just before bulk upsert for ${objectName} row#${i}`);
      }
    }
  }

  const pollTimeout  = strategy.pollTimeoutMs  ?? 10 * 60 * 1000;
  const pollInterval = strategy.pollIntervalMs ?? 2000;

  const {
    jobInfo,
    successfulResults = [],
    failedResults = [],
    unprocessedRecords = []
  } = await conn.bulk2.loadAndWaitForResults({
    object: objectName,
    operation: op,
    ...(op === 'upsert' ? { externalIdFieldName: externalIdField } : {}),
    input: batch,
    pollTimeout,
    pollInterval,
  });

  const successesByKey = new Map();
  const failuresByKey  = new Map();

  const keyFromSuccess = (r) => firstNonEmpty(
    externalIdField && r[externalIdField],
    r.sf__Id, r.Id
  );
  const keyFromFailure = (r) => firstNonEmpty(
    externalIdField && r[externalIdField],
    r.Id
  );

  for (const r of successfulResults) {
    const key = keyFromSuccess(r);
    successesByKey.set(key || Symbol('idx'), r);
  }
  for (const r of failedResults) {
    const key = keyFromFailure(r);
    const msg = r.sf__Error ? String(r.sf__Error) : 'Unknown error';
    const arr = failuresByKey.get(key || Symbol('idx')) || [];
    arr.push({ message: msg });
    failuresByKey.set(key || Symbol('idx'), arr);
  }

  const results = batch.map((row, i) => {
    const key = getKey(row, externalIdField, null, i);

    if (successesByKey.has(key)) {
      const sr = successesByKey.get(key);
      return {
        success: true,
        created: String(sr.sf__Created ?? '').toLowerCase() === 'true',
        id: sr.sf__Id || sr.Id,
        errors: [],
      };
    }
    if (failuresByKey.has(key)) {
      return { success: false, created: false, id: undefined, errors: failuresByKey.get(key) };
    }

    if (op === 'insert') {
      const sr = successfulResults[i];
      if (sr?.sf__Id) {
        return {
          success: true,
          created: String(sr.sf__Created ?? '').toLowerCase() === 'true',
          id: sr.sf__Id,
          errors: [],
        };
      }
      const fr = failedResults[i];
      if (fr?.sf__Error) {
        return { success: false, created: false, id: undefined, errors: [{ message: String(fr.sf__Error) }] };
      }
    }

    return { success: false, created: false, id: undefined, errors: [{ message: 'Row not present in success or failure results' }] };
  });

  const created  = [];
  const updated  = [];
  const failures = [];

  for (let i = 0; i < batch.length; i++) {
    const inRec = batch[i];
    const r = results[i];

    if (!r || !r.success) {
      failures.push({
        index: i,
        key: getKey(inRec, externalIdField, r?.id, i),
        id: r?.id,
        externalId: externalIdField ? inRec?.[externalIdField] : undefined,
        messages: toMsgs(r?.errors),
      });
      continue;
    }

    const entry = {
      index: i,
      key: getKey(inRec, externalIdField, r.id, i),
      id: r.id,
      externalId: externalIdField ? inRec?.[externalIdField] : undefined,
    };
    if (op === 'insert' || r.created) created.push(entry);
    else updated.push(entry);
  }

  let processedRecords = [];
  try {
    if (op === 'upsert') {
      const exts = [...created, ...updated].map(e => e.externalId).filter(Boolean);
      if (exts.length) {
        processedRecords = await conn.sobject(objectName)
          .find({ [externalIdField]: { $in: exts } }, `Id,${externalIdField}`);
      }
    } else {
      const ids = created.map(e => e.id).filter(Boolean);
      if (ids.length) {
        processedRecords = await conn.sobject(objectName)
          .find({ Id: { $in: ids } }, 'Id');
      }
    }
  } catch (e) {
    log.warn('COMMIT', `[${objectName}][Bulk2] Verify query skipped: ${e.message}`);
  }

  if (created.length) log.info("COMMIT", `[${objectName}] Created: ${created.length}`);
  if (updated.length) log.info("COMMIT", `[${objectName}] Updated: ${updated.length}`);
  if (failures.length) {
    log.error("COMMIT", `[${objectName}][Bulk2] Failures: ${failures.length}`);
    for (const f of failures) {
      log.error("COMMIT", `  x row#${f.index} [${f.key}] -> ${f.id ?? 'n/a'}`);
      for (const m of f.messages) log.error("COMMIT", `     - ${m}`);
    }
  }

  return {
    operation: op,
    externalIdField: externalIdField || null,
    jobInfo,
    successfulResults,
    failedResults,
    unprocessedRecords,
    results,
    created,
    updated,
    failures,
    processedRecords,
  };
}

export async function commit(conn, objectName, batch, strategy) {
  const api = strategy.api || 'rest';
  if (api === 'composite') return commitComposite(conn, objectName, batch, strategy);
  if (api === 'bulk') return commitBulk(conn, objectName, batch, strategy);
  return commitREST(conn, objectName, batch, strategy);
}
