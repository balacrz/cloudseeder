// scripts/runLoad.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getConnection } from "../lib/auth.js";
import { insertAndMap } from "../lib/loader.js";
import { setOrgId } from "../lib/runcontext.js";

// filters & generators
import { applyFilter } from "../lib/filters.js";
import { generators as legacyGenerators } from "../services/generators.js";

// centralized config loaders
import { loadStepConfig, loadPipeline, loadConstants } from "../lib/config/index.js";
// reuse the same JSON5-aware reader for data files too
import { readJSON } from "../lib/config/utils.js";

// metadata snapshot (org-aware)
import { snapshotOrgMetadata } from "../lib/metadata.min.js";

//  match key validator (snapshot-based)
import { validateMatchKeysFromSnapshots } from "../lib/validators/validatematchkeys.js";

// --- Resolve __dirname (ESM) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Env / paths ---
const ENV_NAME = process.env.LOADER_ENV || process.env.NODE_ENV || "dev";
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const DATA_ROOT = path.resolve(__dirname, "../"); // pipeline data paths are repo-root relative

// ---------- Small utils ----------
const loadedFiles = Object.create(null);

function loadDataFile(absOrRel) {
  const filePath = path.isAbsolute(absOrRel) ? absOrRel : path.join(DATA_ROOT, absOrRel);
  if (!loadedFiles[filePath]) {
    loadedFiles[filePath] = readJSON(filePath);
  }
  return loadedFiles[filePath];
}

function upsertIdMap(store, objectName, newMap, { preferExisting = true } = {}) {
  const current = store[objectName] || {};
  store[objectName] = preferExisting ? { ...newMap, ...current } : { ...current, ...newMap };
}

// ---------- Step ordering (topological sort by dependsOn) ----------
function topoSortSteps(steps) {
  const indeg = new Array(steps.length).fill(0);
  const adj = steps.map(() => []);

  for (let i = 0; i < steps.length; i++) {
    const deps = steps[i].dependsOn || [];
    if (!deps.length) continue;
    for (let j = 0; j < steps.length; j++) {
      if (i === j) continue;
      const outObj = steps[j].object;
      if (deps.includes(outObj)) {
        adj[j].push(i);
        indeg[i]++;
      }
    }
  }

  const q = [];
  for (let i = 0; i < steps.length; i++) {
    if (indeg[i] === 0) q.push(i);
  }

  const order = [];
  while (q.length) {
    // Always pick the smallest index (original JSON order)
    const u = q.sort((a, b) => a - b).shift();
    order.push(u);
    for (const v of adj[u]) {
      indeg[v]--;
      if (indeg[v] === 0) q.push(v);
    }
  }

  if (order.length !== steps.length) {
    console.warn("[System] Warning⚠️: dependsOn produced a cycle or unresolved edges; using original order.");
    return steps;
  }
  return order.map((idx) => steps[idx]);
}

// ---------- Generators dispatcher ----------
function runGenerator(step, rawData, idMaps) {
  const name = step.generator;
  const fn = legacyGenerators && legacyGenerators[name];
  if (!fn) throw new Error(`Unknown generator '${name}'. Add it to services/generators.js or adjust pipeline.`);
  return fn(rawData, idMaps);
}

// ---------- Logging helpers ----------
function nowIso() { return new Date().toISOString(); }
function ms(s, e) { return `${(e - s).toLocaleString()} ms`; }

// ---------- Main ----------
async function main() {
  const totalStart = Date.now();
  console.log(`[${nowIso()}] [System] ENV=${ENV_NAME} DRY_RUN=${DRY_RUN}`);

  let conn = null;
  if (!DRY_RUN) {
    conn = await getConnection();
    console.log(`[${nowIso()}] [System] Authenticated to Salesforce`);
  } else {
    console.log(`[${nowIso()}] [System] DRY_RUN enabled — will not write to Salesforce`);
  }

  // Centralized config loading
  const constants = loadConstants({ envName: ENV_NAME });
  const pipelineCfg = loadPipeline({ envName: ENV_NAME });

  const pipelineDryRun = Boolean(pipelineCfg.dryRun);
  const effectiveDryRun = DRY_RUN || pipelineDryRun;

  if (!pipelineCfg.steps || !Array.isArray(pipelineCfg.steps) || pipelineCfg.steps.length === 0) {
    throw new Error("pipeline.json missing non-empty 'steps' array");
  }

  // Compute the unique object list from the pipeline itself
  const pipelineObjects = Array.from(
    new Set(
      (pipelineCfg.steps || [])
        .map(s => String(s.object || "").trim())
        .filter(Boolean)
    )
  ).sort();

  let isSnapshotSuccessful = true;
  let snapshotOrgId = null; // capture orgId for validator

  // Snapshot metadata for ONLY those objects, under meta-data/<ORG_ID>/
  if (conn) {
    console.log(`[${nowIso()}] [System] Snapshotting org metadata for ${pipelineObjects.length} object(s)…`);
    const snapshot =  await snapshotOrgMetadata(conn, {
      objectNames: pipelineObjects,
      metaDir: path.resolve(__dirname, "../meta-data"),
      orgId: undefined, // optional override; normally resolved from conn.identity()
      forceRefresh: String(process.env.REFRESH_METADATA || "").toLowerCase() === "true",
      concurrency: 2 // gentle concurrency; raise carefully if needed
    });
    if(snapshot.unavailableObjects.length > 0){
      console.log(`[${nowIso()}] [System] Metadata snapshot failed.`);
      isSnapshotSuccessful = false;
    }else{
      isSnapshotSuccessful = true;
      snapshotOrgId = snapshot.orgId;     // save for later
      setOrgId(snapshot.orgId);           // set once for the whole run
      console.log(`[${nowIso()}] [System] Metadata snapshot complete.`);
    }
  } else {
    console.log(`[${nowIso()}] [System] Skipping metadata snapshot (no connection in DRY_RUN).`);
  }

  if(!isSnapshotSuccessful){
    throw new Error(`Snap shot failed`);
  }

  const stepsOrdered = topoSortSteps(pipelineCfg.steps);
  console.log(`[${nowIso()}] [System] Total Steps: ${stepsOrdered.length}`);

  // Validate mapping identify.matchKey fields against SNAPSHOT files
  if (conn && snapshotOrgId) {
    await validateMatchKeysFromSnapshots({
      steps: stepsOrdered,
      metaDir: path.resolve(__dirname, "../meta-data"),
      orgId: snapshotOrgId,
      loadStepConfig,                        // reuse your existing loader
      envName: ENV_NAME,
      cwd: path.resolve(__dirname, "..")
    });
  }

  const idMaps = Object.create(null);
  const runReport = {
    env: ENV_NAME,
    dryRun: effectiveDryRun,
    startedAt: new Date(totalStart).toISOString(),
    steps: [],
    totals: { attempted: 0, insertedOrUpserted: 0, errors: 0 }
  };

  let stepCount = 0;

  for (const step of stepsOrdered) {
    stepCount++;
    if (!step.object) throw new Error(`Step missing 'object'. Step: ${JSON.stringify(step)}`);
    if (!step.dataFile) throw new Error(`Step for ${step.object} missing 'dataFile'`);
    if (!step.configFile) throw new Error(`Step for ${step.object} must include 'configFile'.`);

    const obj = step.object;

    // Per-step mapping (base -> env -> step.configFile -> step.configInline)
    const cfg = loadStepConfig(step, {
      envName: ENV_NAME,
      // baseDir/envDir default to <cwd>/config/base and <cwd>/config/env — override here if needed
      cwd: path.resolve(__dirname, ".."),
      cache: true
    });

    console.log(`[${nowIso()}] [System] START🚀: ${stepCount} - ${obj}`);
    console.log(`[${nowIso()}] [${obj}] Using config file: ${step.configFile}`);

    const rawData = loadDataFile(step.dataFile);
    const baseData = step.dataKey ? rawData[step.dataKey] : rawData;
    if (!Array.isArray(baseData)) {
      const keys = Array.isArray(rawData) ? "(root is array)" : Object.keys(rawData || {});
      throw new Error(`Data at key '${step.dataKey || "<root>"}' for ${obj} is not an array. Available keys: ${keys}`);
    }

    // Filter at step level (optional)
    const working = applyFilter(baseData, step.filter);
    console.log(`[${nowIso()}] [${obj}] RECORDS TO PROCESS: ${working.length}`);

    let finalData;
    if ((step.mode || "").toLowerCase() === "generate") {
      console.log(`[${nowIso()}] [${obj}] Running generator: ${step.generator}`);
      finalData = runGenerator(step, rawData, idMaps);
      if (!Array.isArray(finalData)) {
        throw new Error(`Generator '${step.generator}' for ${obj} did not return an array`);
      }
    } else {
      finalData = working;
    }

    console.log(`[${nowIso()}] [${obj}] RECORDS PROCESSED: ${finalData.length}`);

    const recStart = Date.now();
    let idMap = {};
    let okCount = 0;
    let errCount = 0;

    if (effectiveDryRun) {
      const preview = finalData.slice(0, Math.min(3, finalData.length));
      console.log(`[${nowIso()}] [System] DRY_RUN preview (${obj}):`, JSON.stringify(preview, null, 2));
      okCount = finalData.length;
    } else {
      // Ensure we await insertAndMap so idMaps are ready for downstream steps
      idMap = await insertAndMap(conn, obj, finalData, cfg, idMaps, constants);
      okCount = Object.keys(idMap).length;
      errCount = Math.max(0, finalData.length - okCount);
      upsertIdMap(idMaps, obj, idMap, { preferExisting: true });
    }

    const recEnd = Date.now();
    console.log(
      `[${nowIso()}] [System] SUMMARY: ${obj} (ok=${okCount}, errors=${errCount}, elapsed=${ms(recStart, recEnd)})`
    );

    runReport.steps.push({
      object: obj,
      dataFile: step.dataFile,
      dataKey: step.dataKey || "<root>",
      mode: (step.mode || "direct").toLowerCase(),
      generator: step.generator || null,
      configFile: step.configFile,
      attempted: finalData.length,
      ok: okCount,
      errors: errCount,
      elapsedMs: recEnd - recStart
    });
    runReport.totals.attempted += finalData.length;
    runReport.totals.insertedOrUpserted += okCount;
    runReport.totals.errors += errCount;

    console.log(`[${nowIso()}] [System] END: ${obj}`);
  }

  const totalEnd = Date.now();
  runReport.finishedAt = new Date(totalEnd).toISOString();
  runReport.totalElapsedMs = totalEnd - totalStart;

  console.log(`[${nowIso()}] [System] Completed ✅ total=${ms(totalStart, totalEnd)}`);
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] [System] ERROR❌:`, err?.stack || err?.message || err);
  process.exit(1);
});
