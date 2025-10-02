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
    for (const c of created) console.log(`  + ${c.key} -> ${c.id}`);
  }
  if (updated.length) {
    console.log(`[${objectName}] Updated: ${updated.length}`);
    for (const u of updated) console.log(`  ~ ${u.key} -> ${u.id}`);
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

async function commitBulk(conn, objectName, batch, strategy) {
  // TODO: implement Bulk insert/upsert if needed
  // For now, fallback to REST
  return commitREST(conn, objectName, batch, strategy);
}

export async function commit(conn, objectName, batch, strategy) {
  const api = strategy.api || 'rest';
  if (api === 'composite') return commitComposite(conn, objectName, batch, strategy);
  if (api === 'bulk') return commitBulk(conn, objectName, batch, strategy);
  return commitREST(conn, objectName, batch, strategy);
}