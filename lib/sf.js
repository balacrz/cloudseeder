/** Strategy committers (REST & Composite; Bulk stub) */
async function commitREST(conn, objectName, batch, strategy) {
  if (strategy.operation === 'upsert') {
    // jsforce supports array upsert
    const results = await conn.sobject(objectName).upsert(batch, strategy.externalIdField);
    const updatedExternalIds = batch
                    .filter((_, i) => results[i].success && !results[i].created)
                    .map(r => r[strategy.externalIdField]);

    // Query Salesforce to get Ids for updated records
    const processedRecords = await conn.sobject(objectName)
                    .find({ [strategy.externalIdField]: { $in: updatedExternalIds } }, 'Id,' + strategy.externalIdField);
    return processedRecords;
  }
  const results = await conn.sobject(objectName).insert(batch);
  return results;
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