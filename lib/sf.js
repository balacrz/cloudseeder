/** Strategy committers (REST & Composite; Bulk stub) */
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

  // Guard: ensure each row still has the external id at DML time.
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

  // Build the list of external IDs to verify on-org (both created & updated)
  const verifyExternalIds = [...created, ...updated]
    .map(e => e.externalId)
    .filter(Boolean);

  // Fetch Id + external id to confirm state (avoid empty $in)
  let processedRecords = [];
  if (verifyExternalIds.length > 0) {
    processedRecords = await conn.sobject(objectName)
      .find({ [externalIdField]: { $in: verifyExternalIds } }, `Id,${externalIdField}`);
  }

  // Optional: emit concise logs (keep or remove)
  if (created.length) {
    console.log(`[${objectName}] Created: ${created.length}`);
    //for (const c of created) console.log(`  + ${c.key} -> ${c.id}`);
  }
  if (updated.length) {
    console.log(`[${objectName}] Updated: ${updated.length}`);
    //for (const u of updated) console.log(`  ~ ${u.key} -> ${u.id}`);
  }
  if (failures.length) {
    console.error(`[${objectName}] Failures: ${failures.length}`);
    for (const f of failures) {
      console.error(`  x row#${f.index} [${f.key}] -> ${f.id ?? 'n/a'}`);
      for (const m of f.messages) console.error(`     - ${m}`);
    }
  }

  // Return a structured result the rest of your pipeline can use
  return {
    operation: 'upsert',
    externalIdField,
    results,            // raw jsforce SaveResult[] for full fidelity
    created,            // [{ index, key, id, externalId }]
    updated,            // [{ index, key, id, externalId }]
    failures,           // [{ index, key, id, externalId, messages[] }]
    processedRecords,   // [{ Id, <externalIdField> }, ...] fetched by $in
  };
}


async function commitComposite(conn, objectName, batch, strategy) {
  // Minimal composite example: fallback to REST per-record (works with jsforce).
  // Replace with a true Composite request if you want single-call semantics.
  const results = [];
  for (const rec of batch) {
    try {
      let res;
      if (strategy.operation === 'upsert') {
        res = await conn.sobject(objectName).upsert(rec, strategy.externalIdField);
      } else {
        res = await conn.sobject(objectName).insert(rec);
      }
      // Normalize result
      if (Array.isArray(res)) results.push(...res);
      else results.push(res);
    } catch (e) {
      results.push({ success: false, errors: [{ message: e.message }] });
    }
  }
  return results;
}

// ---- commitBulk (Bulk API 2.0; jsforce v2) ---------------------------------
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

  const pollTimeout  = strategy.pollTimeoutMs  ?? 10 * 60 * 1000; // 10m
  const pollInterval = strategy.pollIntervalMs ?? 2000;           // 2s

  // --- execute Bulk 2.0 (one call, end-to-end) ------------------------------
  // jsforce v2 returns: { jobInfo, successfulResults, failedResults, unprocessedRecords }
  const {
    jobInfo,
    successfulResults = [],
    failedResults = [],
    unprocessedRecords = []
  } = await conn.bulk2.loadAndWaitForResults({
    object: objectName,
    operation: op,
    ...(op === 'upsert' ? { externalIdFieldName: externalIdField } : {}),
    input: batch,            // jsforce CSV-encodes the objects for you
    pollTimeout,
    pollInterval,
  });

  // --- normalize per-row outcomes ------------------------------------------
  // successfulResults rows typically include: sf__Id, sf__Created, plus original columns
  // failedResults rows include: sf__Error, plus original columns
  const successesByKey = new Map();
  const failuresByKey  = new Map();

  // Prefer externalId (for upsert); otherwise try Id; else we’ll align by index later
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
    successesByKey.set(key || Symbol('idx'), r); // Symbol forces index fallback later if needed
  }
  for (const r of failedResults) {
    const key = keyFromFailure(r);
    const msg = r.sf__Error ? String(r.sf__Error) : 'Unknown error';
    const arr = failuresByKey.get(key || Symbol('idx')) || [];
    arr.push({ message: msg });
    failuresByKey.set(key || Symbol('idx'), arr);
  }

  // Build per-input aligned array (best effort):
  //  - For upsert, alignment is reliable via externalId.
  //  - For pure insert, we align by position if we can’t match a key.
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

    // Fallbacks for inserts when no solid key:
    // If lengths line up, assume positional mapping for quick clarity.
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

    // If nothing matched, treat as failure with clear message
    return { success: false, created: false, id: undefined, errors: [{ message: 'Row not present in success or failure results' }] };
  });

  // --- split into created / updated / failures (like your REST output) ------
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

  // --- optional verification query (matches your REST flow) -----------------
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
    // Non-fatal: verification failed (FLS or describe issues); keep going
    console.warn(`[${objectName}][Bulk2] Verify query skipped: ${e.message}`);
  }

  // --- concise logs (your style) --------------------------------------------
  if (created.length) {
    console.log(`[${objectName}][Bulk2] Created: ${created.length}`);
    //for (const c of created) console.log(`  + ${c.key} -> ${c.id}`);
  }
  if (updated.length) {
    console.log(`[${objectName}][Bulk2] Updated: ${updated.length}`);
    //for (const u of updated) console.log(`  ~ ${u.key} -> ${u.id}`);
  }
  if (failures.length) {
    console.error(`[${objectName}][Bulk2] Failures: ${failures.length}`);
    for (const f of failures) {
      console.error(`  x row#${f.index} [${f.key}] -> ${f.id ?? 'n/a'}`);
      //for (const m of f.messages) console.error(`     - ${m}`);
    }
  }

  // --- return ----------------------------------------------------------------
  return {
    operation: op,
    externalIdField: externalIdField || null,
    jobInfo,
    // Note: exposing raw arrays from jsforce is optional; keeping parity with v2 helper names:
    successfulResults,
    failedResults,
    unprocessedRecords,
    // normalized:
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