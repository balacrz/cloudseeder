// scripts/runLoad.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import JSON5 from "json5";

import { getConnection } from "../lib/auth.js";
import { insertAndMap } from "../lib/loader.js";

// ✅ use your new filter module
import { applyFilter } from "../lib/filters.js";

// Generators (still supported)
import { generators as legacyGenerators } from "../services/generators.js";

// --- Resolve __dirname in ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config locations (adjust if your tree is different) ---
const CONFIG_DIR = path.resolve(__dirname, "../config");
const MAPPINGS_DIR = path.join(CONFIG_DIR, "mappings");
const ENV_DIR = path.join(CONFIG_DIR, "env"); // optional overlays: config/env/dev, etc.
const DATA_ROOT = path.resolve(__dirname, "../"); // data paths in pipeline are relative to repo root

// --- CLI/env options ---
const ENV_NAME = process.env.LOADER_ENV || "dev"; // dev|qa|prod
const PIPELINE_BASE = path.join(CONFIG_DIR, "pipeline.json");
const PIPELINE_ENV = path.join(ENV_DIR, ENV_NAME, "pipeline.json");
const CONSTANTS_BASE = path.join(CONFIG_DIR, "constants.json");
const CONSTANTS_ENV = path.join(ENV_DIR, ENV_NAME, "constants.json");

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";

// ---------- Small utils ----------
const loadedFiles = Object.create(null);

function readJSON(p) {
  const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""); // strip BOM
  return JSON5.parse(raw); // accepts comments & trailing commas
}

function deepMerge(target, ...sources) {
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        target[k] = deepMerge(target[k] || {}, v);
      } else {
        target[k] = v;
      }
    }
  }
  return target;
}

function loadConstants() {
  const base = fs.existsSync(CONSTANTS_BASE) ? readJSON(CONSTANTS_BASE) : {};
  const envPath = CONSTANTS_ENV;
  const env = fs.existsSync(envPath) ? readJSON(envPath) : {};
  return deepMerge({}, base, env);
}

function loadPipeline() {
  if (!fs.existsSync(PIPELINE_BASE)) {
    throw new Error(`Missing pipeline at ${PIPELINE_BASE}`);
  }
  const base = readJSON(PIPELINE_BASE);
  const env = fs.existsSync(PIPELINE_ENV) ? readJSON(PIPELINE_ENV) : {};
  return deepMerge({}, base, env);
}

function loadObjectConfig(objectName) {
  const baseFile = path.join(MAPPINGS_DIR, `${objectName}.json`);
  if (!fs.existsSync(baseFile)) {
    throw new Error(`Mapping not found for ${objectName}: ${baseFile}`);
  }
  const base = readJSON(baseFile);

  const envFile = path.join(ENV_DIR, ENV_NAME, `${objectName}.json`);
  const env = fs.existsSync(envFile) ? readJSON(envFile) : {};
  return deepMerge({}, base, env);
}

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
  for (let i = 0; i < steps.length; i++) if (indeg[i] === 0) q.push(i);

  const order = [];
  while (q.length) {
    const u = q.shift();
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

  const constants = loadConstants();
  const pipelineCfg = loadPipeline();

  const pipelineDryRun = Boolean(pipelineCfg.dryRun);
  const effectiveDryRun = DRY_RUN || pipelineDryRun;

  if (!pipelineCfg.steps || !Array.isArray(pipelineCfg.steps) || pipelineCfg.steps.length === 0) {
    throw new Error("pipeline.json missing non-empty 'steps' array");
  }

  const stepsOrdered = topoSortSteps(pipelineCfg.steps);
  console.log(`[${nowIso()}] [System] Total Steps: ${stepsOrdered.length}`);

  const idMaps = Object.create(null);
  const runReport = {
    env: ENV_NAME,
    dryRun: effectiveDryRun,
    startedAt: new Date(totalStart).toISOString(),
    steps: [],
    totals: { attempted: 0, insertedOrUpserted: 0, errors: 0 }
  };

  for (const step of stepsOrdered) {
    const obj = step.object;
    const cfg = loadObjectConfig(obj);
    console.log(`[${nowIso()}] [System] START🚀: ${obj}`);

    if (!step.dataFile) {
      throw new Error(`Step for ${obj} missing 'dataFile'`);
    }
    const rawData = loadDataFile(step.dataFile);

    const baseData = step.dataKey ? rawData[step.dataKey] : rawData;
    if (!Array.isArray(baseData)) {
      const keys = Array.isArray(rawData) ? "(root is array)" : Object.keys(rawData || {});
      throw new Error(`Data at key '${step.dataKey || "<root>"}' for ${obj} is not an array. Available keys: ${keys}`);
    }

    // ✅ Config-driven filter
    const working = applyFilter(baseData, step.filter);
    console.log(`[${nowIso()}] [${obj}] RECORDS tO PROCESS: ${working.length}`);

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
      idMap = await insertAndMap(conn, obj, finalData, cfg, idMaps, constants);
      okCount = Object.keys(idMap).length;
      errCount = Math.max(0, finalData.length - okCount);
      upsertIdMap(idMaps, obj, idMap, { preferExisting: true });
    }

    const recEnd = Date.now();
    console.log(`[${nowIso()}] [System] SUMMARY: ${obj} (ok=${okCount}, errors=${errCount}, elapsed=${ms(recStart, recEnd)})`);

    runReport.steps.push({
      object: obj,
      dataFile: step.dataFile,
      dataKey: step.dataKey || "<root>",
      mode: (step.mode || "direct").toLowerCase(),
      generator: step.generator || null,
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
