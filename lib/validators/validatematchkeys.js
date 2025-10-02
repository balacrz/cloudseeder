// lib/validators/validatematchkeys.js
import fs from "fs";
import path from "path";

/** ---------- Small helpers ---------- */
function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}
function toArray(v) { return !v ? [] : (Array.isArray(v) ? v : [v]); }
function getMatchKeys(cfg) {
  const raw = cfg?.identify?.matchKey;
  return toArray(raw).map(s => String(s).trim()).filter(Boolean);
}
function buildFieldSetFromDescribe(describeJson) {
  const set = new Set();
  for (const f of (describeJson.fields || [])) set.add(f.name);
  return set;
}
function readDescribeSnapshot({ metaDir, orgId, objectName }) {
  const filePath = path.join(metaDir, orgId, `${objectName}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Describe snapshot not found for ${objectName} at ${filePath}`);
  }
  return { json: readJSON(filePath), filePath };
}
function labelFromApi(fieldApiName) {
  // crude but serviceable: BKAI__External_Id__c -> External Id
  const base = fieldApiName.endsWith("__c")
    ? fieldApiName.slice(0, -3).split("__").pop()
    : fieldApiName;
  return base.replace(/_/g, " ");
}

/** ---------- Metadata helpers (create + verify) ---------- */
async function createTextExternalIdField(conn, objectName, fieldApiName, log) {
  const metadata = [{
    fullName: `${objectName}.${fieldApiName}`,
    label: labelFromApi(fieldApiName),
    type: "Text",
    length: 255,
    externalId: true,
    unique: true,
    required: false
  }];

  log.info(`Creating field ${objectName}.${fieldApiName} (Text(255), External Id, Unique)…`);
  const res = await conn.metadata.create("CustomField", metadata);

  // jsforce returns either an object or array; normalize
  const results = Array.isArray(res) ? res : [res];
  const r = results[0];
  if (!r) throw new Error(`No result from metadata.create for ${objectName}.${fieldApiName}`);
  if (String(r.success) !== "true") {
    const probs = toArray(r?.errors)
      .map(e => (e?.message || e))
      .join("; ");
    throw new Error(`Failed creating ${objectName}.${fieldApiName}: ${probs || "Unknown error"}`);
  }
  log.info(`Field created: ${objectName}.${fieldApiName}`);
}

/**
 * Refresh the local snapshot file for a single object by calling describe() live.
 * This keeps your meta-data/<orgId>/<Object>.json in sync after field creation.
 */
async function refreshSingleSnapshot(conn, { metaDir, orgId, objectName }, log) {
  log.info(`Refreshing local snapshot for ${objectName}…`);
  const d = await conn.sobject(objectName).describe();
  const targetPath = path.join(metaDir, orgId, `${objectName}.json`);
  writeJSON(targetPath, d);
  log.info(`Snapshot updated: ${targetPath}`);
}

/** ---------- Main validator/export ---------- */
/**
 * Validate mapping match keys using saved snapshots. If AUTO_CREATE_MATCH_KEYS=true
 * and a key is missing, create it (Text 255, External Id, Unique) via Metadata API,
 * then re-snapshot that object locally and re-validate it.
 *
 * @param {Object} opts
 * @param {Array}  opts.steps
 * @param {String} opts.metaDir
 * @param {String} opts.orgId
 * @param {Function} opts.loadStepConfig
 * @param {String} opts.envName
 * @param {String} opts.cwd
 * @param {Function} [opts.logFn] (tag, msg) => void
 * @param {Object} [opts.consoleLog] {info,warn,error,debug}
 * @param {Object} [opts.conn] jsforce connection (required for auto-create)
 */
export async function validateMatchKeysFromSnapshots({
  steps,
  metaDir,
  orgId,
  loadStepConfig,
  envName,
  cwd,
  logFn,
  consoleLog,
  conn
}) {
  const L = {
    info:  (m) => { consoleLog?.info?.("VALIDATOR", m);  logFn?.("VALIDATOR", m); },
    warn:  (m) => { consoleLog?.warn?.("VALIDATOR", m);  logFn?.("VALIDATOR", m); },
    error: (m) => { consoleLog?.error?.("VALIDATOR", m); logFn?.("VALIDATOR", m); },
    json:  (label, obj) => {
      if (logFn) {
        logFn("VALIDATOR", `${label} >>>`);
        logFn("VALIDATOR", JSON.stringify(obj, null, 2));
        logFn("VALIDATOR", "<<< END JSON");
      }
    }
  };

  const AUTO_CREATE = String(process.env.AUTO_CREATE_MATCH_KEYS || "").toLowerCase() === "true";
  if (AUTO_CREATE && !conn) {
    L.warn("AUTO_CREATE_MATCH_KEYS=true but no connection provided — will validate only.");
  }

  L.info("Validating identify.matchKey fields against snapshot…");

  // Cache snapshots per object to avoid repeated I/O
  const snapshotCache = new Map(); // objectName -> { json, filePath, fieldSet }
  const warnings = [];
  let missing = [];  // aggregated missing keys: {object, key}

  // 1) First pass — collect all missing keys based on current snapshots
  for (const step of steps) {
    const objectName = String(step.object || "").trim();
    if (!objectName) continue;

    let mappingCfg;
    try {
      mappingCfg = loadStepConfig(step, { envName, cwd, cache: true });
    } catch (e) {
      const msg = `Failed to load mapping for ${objectName}: ${e?.message || e}`;
      L.error(msg);
      missing.push({ object: objectName, key: "<mapping load failed>", reason: msg });
      continue;
    }

    const keys = getMatchKeys(mappingCfg);
    if (!keys.length) {
      warnings.push({ object: objectName, message: "No identify.matchKey defined." });
      continue;
    }

    // load snapshot
    let snap = snapshotCache.get(objectName);
    if (!snap) {
      try {
        const { json, filePath } = readDescribeSnapshot({ metaDir, orgId, objectName });
        snap = { json, filePath, fieldSet: buildFieldSetFromDescribe(json) };
        snapshotCache.set(objectName, snap);
      } catch (e) {
        const msg = `Snapshot read failed for ${objectName}: ${e?.message || e}`;
        L.error(msg);
        missing.push({ object: objectName, key: "<no snapshot>", reason: msg });
        continue;
      }
    }

    for (const key of keys) {
      if (!snap.fieldSet.has(key)) {
        missing.push({ object: objectName, key, reason: "not in snapshot" });
      }
    }
  }

  for (const w of warnings) L.warn(`${w.object}: ${w.message}`);

  // 2) If auto-create is allowed, try to create missing keys, then refresh snapshots for those objects
  if (AUTO_CREATE && conn && missing.length) {
    // Group missing by object
    const byObject = new Map();
    for (const m of missing) {
      if (!byObject.has(m.object)) byObject.set(m.object, []);
      if (m.key && m.key !== "<mapping load failed>" && m.key !== "<no snapshot>") {
        byObject.get(m.object).push(m.key);
      }
    }

    L.info(`AUTO_CREATE_MATCH_KEYS=true — attempting to create ${missing.length} missing key(s)…`);
    L.json("Missing (pre-create)", missing);

    // Create fields, one object at a time; de-dup keys per object
    for (const [objectName, keys] of byObject.entries()) {
      const uniqueKeys = [...new Set(keys)];
      for (const key of uniqueKeys) {
        try {
          await createTextExternalIdField(conn, objectName, key, L);
        } catch (e) {
          L.error(`Creation failed for ${objectName}.${key}: ${e?.message || e}`);
        }
      }
      // Re-snapshot this object so local file includes the new field(s)
      try {
        await refreshSingleSnapshot(conn, { metaDir, orgId, objectName }, L);
        // Update cache
        const fresh = readDescribeSnapshot({ metaDir, orgId, objectName });
        snapshotCache.set(objectName, {
          json: fresh.json,
          filePath: fresh.filePath,
          fieldSet: buildFieldSetFromDescribe(fresh.json)
        });
      } catch (e) {
        L.error(`Snapshot refresh failed for ${objectName}: ${e?.message || e}`);
      }
    }

    // Re-run the check quickly after attempted creation
    const remaining = [];
    for (const m of missing) {
      if (!m.key || m.key === "<mapping load failed>" || m.key === "<no snapshot>") {
        remaining.push(m);
        continue;
      }
      const snap = snapshotCache.get(m.object);
      if (!snap || !snap.fieldSet.has(m.key)) {
        remaining.push(m); // still missing
      }
    }
    missing = remaining;
  }

  // 3) Final decision — log + throw if anything still missing
  if (missing.length) {
    L.json("MATCH KEY VALIDATION ERRORS", missing);
    for (const e of missing) L.error(`${e.object}: '${e.key}' missing`);
    const err = new Error(
      AUTO_CREATE
        ? "Match key validation failed after auto-create — see run log for details."
        : "Match key validation failed — see run log for details."
    );
    err.details = missing;
    throw err;
  }

  L.info("All match keys exist ✅");
}
