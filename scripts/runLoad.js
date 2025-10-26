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

// your console logger
import { log } from "../lib/utils/logger.js";

// single-file run logger
import { createRunLogSingle } from "../lib/utils/runlog.js";

// --- Resolve __dirname (ESM) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Env / paths ---
const ENV_NAME = process.env.LOADER_ENV || process.env.NODE_ENV || "dev";
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const DATA_ROOT = path.resolve(__dirname, "../"); // pipeline data paths are repo-root relative

// ---------- Small utils ----------
const loadedFiles = Object.create(null);
const nowIso = () => new Date().toISOString();
const ms = (s, e) => `${(e - s).toLocaleString()} ms`;

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
    log.warn("System", "dependsOn produced a cycle; using original order.");
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

let runLog = null;

// ---------- Main ----------
async function main() {
  runLog = createRunLogSingle("logs"); // logs/run-<stamp>.log (single file)
  const fileLog = (tag, msg) => runLog.write(tag, msg);

  const totalStart = Date.now();
  log.info("System", `ENV=${ENV_NAME} DRY_RUN=${DRY_RUN}`);
  fileLog("System", `Start — ENV=${ENV_NAME} DRY_RUN=${DRY_RUN}`);

  let conn = null;
  if (!DRY_RUN) {
    conn = await getConnection();
    log.info("System", "Authenticated to Salesforce ✅");
    fileLog("System", "Authenticated to Salesforce ✅");
  } else {
    log.info("System", "DRY_RUN enabled — will not write to Salesforce");
    fileLog("System", "DRY_RUN enabled — will not write to Salesforce");
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
    fileLog("SNAPSHOT", `Starting… objects=${pipelineObjects.length}`);
    const snapshot =  await snapshotOrgMetadata(conn, {
      objectNames: pipelineObjects,
      metaDir: path.resolve(__dirname, "../meta-data"),
      orgId: undefined, // optional override; normally resolved from conn.identity()
      forceRefresh: String(process.env.REFRESH_METADATA || "").toLowerCase() === "true",
      concurrency: 2 // gentle concurrency; raise carefully if needed
    });
    if(snapshot.unavailableObjects.length > 0){
      const msg = `Metadata snapshot failed; unavailable=${snapshot.unavailableObjects.join(",")}`;
      log.error("System", msg);
      fileLog("SNAPSHOT", msg);
      isSnapshotSuccessful = false;
    } else {
      isSnapshotSuccessful = true;
      snapshotOrgId = snapshot.orgId;
      setOrgId(snapshot.orgId);
      log.info("System", `Metadata snapshot complete ✅ orgId=${snapshot.orgId}`);
      fileLog("SNAPSHOT", `Complete ✅ orgId=${snapshot.orgId}`);
    }
  } else {
    log.warn("System", "Skipping metadata snapshot (no connection in DRY_RUN)");
    fileLog("SNAPSHOT", "Skipping metadata snapshot (no connection in DRY_RUN)");
  }

  if(!isSnapshotSuccessful){
    runLog.writeJson("System", "Fatal", { error: "Snapshot failed" });
    runLog.close();
    throw new Error(`Snapshot failed`);
  }

  const stepsOrdered = topoSortSteps(pipelineCfg.steps);
  log.info("System", `Total Steps: ${stepsOrdered.length}`);
  fileLog("System", `Total Steps: ${stepsOrdered.length}`);

  // Validate match keys vs snapshot — all into same single log
  if (conn && snapshotOrgId) {
    await validateMatchKeysFromSnapshots({
      steps: stepsOrdered,
      metaDir: path.resolve(__dirname, "../meta-data"),
      orgId: snapshotOrgId,
      loadStepConfig,                        // reuse your existing loader
      envName: ENV_NAME,
      cwd: path.resolve(__dirname, ".."),
      logFn: fileLog,
      consoleLog: log,
      conn
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

  let stepIndex = 0;

  for (const step of stepsOrdered) {
    stepIndex++;
    if (!step.object) throw new Error(`Step missing 'object'. Step: ${JSON.stringify(step)}`);
    if (!step.dataFile) throw new Error(`Step for ${step.object} missing 'dataFile'`);
    if (!step.configFile) throw new Error(`Step for ${step.object} must include 'configFile'.`);

    const obj = step.object;

    log.info(obj, `START 🚀 #${stepIndex} [${obj}] Using config file=${step.configFile}`);
    fileLog(`STEP:${obj}`, `START 🚀 #${stepIndex} [${obj}] Using config file=${step.configFile}`);
    log.stepStart(obj);

    const cfg = loadStepConfig(step, {
      envName: ENV_NAME,
      // baseDir/envDir default to <cwd>/config/base and <cwd>/config/env — override here if needed
      cwd: path.resolve(__dirname, ".."),
      cache: true
    });

    const rawData = loadDataFile(step.dataFile);
    const baseData = step.dataKey ? rawData[step.dataKey] : rawData;
    if (!Array.isArray(baseData)) {
      const keys = Array.isArray(rawData) ? "(root is array)" : Object.keys(rawData || {});
      throw new Error(`Data at key '${step.dataKey || "<root>"}' for ${obj} is not an array. Keys: ${keys}`);
    }

    // Filter at step level (optional)
    const working = applyFilter(baseData, step.filter);
    const mode = (step.mode || "direct").toLowerCase();
    log.info(obj, `Records to process: ${working.length} (mode=${mode})`);
    fileLog(`STEP:${obj}`, `Records to process: ${working.length} (mode=${mode})`);

    let finalData;
    if (mode === "generate") {
      log.info(obj, `Running generator: ${step.generator}`);
      fileLog(`STEP:${obj}`, `Running generator: ${step.generator}`);
      finalData = runGenerator(step, rawData, idMaps);
      if (!Array.isArray(finalData)) throw new Error(`Generator '${step.generator}' for ${obj} did not return an array`);
    } else {
      finalData = working;
    }

    log.debug(obj, `Processed record count: ${finalData.length}`);
    fileLog(`STEP:${obj}`, `Processed record count: ${finalData.length}`);

    const recStart = Date.now();
    let idMap = {};
    let okCount = 0;
    let errCount = 0;

    if (effectiveDryRun) {
      const sample = finalData.slice(0, Math.min(3, finalData.length));
      log.debug(obj, `DRY_RUN sample: ${JSON.stringify(sample)}`);
      fileLog(`STEP:${obj}`, `DRY_RUN sample: ${JSON.stringify(sample)}`);
      okCount = finalData.length;
    } else {
      idMap = await insertAndMap(conn, obj, finalData, cfg, idMaps, constants);
      okCount = Object.keys(idMap).length;
      errCount = Math.max(0, finalData.length - okCount);
      upsertIdMap(idMaps, obj, idMap, { preferExisting: true });
    }

    const recEnd = Date.now();
    const summary = `ok=${okCount} errors=${errCount} elapsed=${ms(recStart, recEnd)}`;
    log.info(obj, `SUMMARY ✅ ${summary}`);
    fileLog(`STEP:${obj}`, `SUMMARY ✅ ${summary}`);

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

    log.stepEnd(obj, summary);
    fileLog(`STEP:${obj}`, `END 🏁 ${summary}`);
  }

  const totalEnd = Date.now();
  runReport.finishedAt = new Date(totalEnd).toISOString();
  runReport.totalElapsedMs = totalEnd - totalStart;

  // Append the final report JSON into the SAME single log file
  runLog.writeJson("System", "RUN REPORT", runReport);

  log.info("System", `Completed ✅ total=${ms(totalStart, totalEnd)} • logFile=${runLog.path}`);
  fileLog("System", `Completed ✅ total=${ms(totalStart, totalEnd)} • logFile=${runLog.path}`);

  runLog.close();
}

main().catch(async (err) => {
  const msg = err?.message || err?.stack || String(err);
  try {
    if(runLog){
      runLog.write("System", `ERROR❌ ${msg}`);
      runLog.close();
      console.error(`[${new Date().toISOString()}] [System] 1 ERROR❌:`, msg);
      await new Promise(res => setTimeout(res, 10));
      process.exit(1);
    }else{
      console.log('RUN LOG NOT AVAILABLE');
    }
  } catch (err) {
  }
});
