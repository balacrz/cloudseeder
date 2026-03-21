// lib/pipeline/orchestrator.js
/**
 * Core pipeline execution engine.
 *
 * Receives an authenticated connection (or null for dry-run), a typed config
 * object from loadEnvConfig(), and a dual-logger. Returns a structured run report.
 */

import path from 'path';
import { applyFilter } from '../filters.js';
import { insertAndMap } from '../loader.js';
import { loadStepConfig, loadPipeline, loadConstants } from '../config/index.js';
import { validateMatchKeysFromSnapshots } from '../validators/validatematchkeys.js';
import { snapshotOrgMetadata } from '../salesforce/metadata.min.js';
import { setOrgId } from '../utils/runcontext.js';
import { topoSortSteps } from './toposort.js';
import { runGenerator } from './generators.js';
import { loadDataFile } from './dataloader.js';

const ms = (s, e) => `${(e - s).toLocaleString()} ms`;

function upsertIdMap(store, objectName, newMap, { preferExisting = true } = {}) {
  const current = store[objectName] || {};
  store[objectName] = preferExisting ? { ...newMap, ...current } : { ...current, ...newMap };
}

/**
 * Execute the full data load pipeline.
 *
 * @param {object|null} conn   - jsforce.Connection, or null when dry-running
 * @param {object}      cfg    - result of loadEnvConfig()
 * @param {object}      opts
 * @param {string}      opts.cwd - project root directory (absolute)
 * @param {object}      opts.L   - dual logger with .info/.warn/.error/.debug(tag, msg)
 * @returns {Promise<object>} run report
 */
export async function runPipeline(conn, cfg, { cwd, L }) {
  const { envName: ENV_NAME, dryRun: DRY_RUN, refreshMetadata, metaConcurrency } = cfg.loader;
  const metaDir = path.resolve(cwd, 'meta-data');
  const totalStart = Date.now();

  const constants = loadConstants({ envName: ENV_NAME });
  const pipelineCfg = loadPipeline({ envName: ENV_NAME });
  const effectiveDryRun = DRY_RUN || Boolean(pipelineCfg.dryRun);

  if (!pipelineCfg.steps || !Array.isArray(pipelineCfg.steps) || pipelineCfg.steps.length === 0) {
    throw new Error("pipeline.json missing non-empty 'steps' array");
  }

  const pipelineObjects = Array.from(
    new Set(
      (pipelineCfg.steps || [])
        .map(s => String(s.object || '').trim())
        .filter(Boolean)
    )
  ).sort();

  // ---------- Metadata snapshot ----------
  let snapshotOrgId = null;
  if (conn) {
    L.info('SNAPSHOT', `Starting… objects=${pipelineObjects.length}`);
    const snapshot = await snapshotOrgMetadata(conn, {
      objectNames: pipelineObjects,
      metaDir,
      orgId: undefined,
      forceRefresh: refreshMetadata,
      concurrency: metaConcurrency,
    });
    if (snapshot.unavailableObjects.length > 0) {
      const msg = `Metadata snapshot failed; unavailable=${snapshot.unavailableObjects.join(',')}`;
      L.error('SNAPSHOT', msg);
      throw new Error('Snapshot failed');
    }
    snapshotOrgId = snapshot.orgId;
    setOrgId(snapshot.orgId);
    L.info('System', `Metadata snapshot complete ✅ orgId=${snapshot.orgId}`);
  } else {
    L.warn('System', 'Skipping metadata snapshot (no connection in DRY_RUN)');
  }

  // ---------- Topological sort + match key validation ----------
  const stepsOrdered = topoSortSteps(pipelineCfg.steps);
  L.info('System', `Total Steps: ${stepsOrdered.length}`);

  if (conn && snapshotOrgId) {
    await validateMatchKeysFromSnapshots({
      steps: stepsOrdered,
      metaDir,
      orgId: snapshotOrgId,
      loadStepConfig,
      envName: ENV_NAME,
      cwd,
      logFn: null,
      consoleLog: L,
      conn,
    });
  }

  // ---------- Step execution loop ----------
  const idMaps = Object.create(null);
  const runReport = {
    env: ENV_NAME,
    dryRun: effectiveDryRun,
    startedAt: new Date(totalStart).toISOString(),
    steps: [],
    totals: { attempted: 0, insertedOrUpserted: 0, errors: 0 },
  };

  let stepIndex = 0;
  for (const step of stepsOrdered) {
    stepIndex++;
    if (!step.object) throw new Error(`Step missing 'object'. Step: ${JSON.stringify(step)}`);
    if (!step.dataFile) throw new Error(`Step for ${step.object} missing 'dataFile'`);
    if (!step.configFile) throw new Error(`Step for ${step.object} must include 'configFile'.`);

    const obj = step.object;
    L.info(obj, `START 🚀 #${stepIndex} [${obj}] Using config file=${step.configFile}`);

    const stepCfg = loadStepConfig(step, { envName: ENV_NAME, cwd, cache: true });
    const rawData = loadDataFile(step.dataFile, cwd);
    const baseData = step.dataKey ? rawData[step.dataKey] : rawData;
    if (!Array.isArray(baseData)) {
      const keys = Array.isArray(rawData) ? '(root is array)' : Object.keys(rawData || {});
      throw new Error(`Data at key '${step.dataKey || '<root>'}' for ${obj} is not an array. Keys: ${keys}`);
    }

    const working = applyFilter(baseData, step.filter);
    const mode = (step.mode || 'direct').toLowerCase();
    L.info(obj, `Records to process: ${working.length} (mode=${mode})`);

    let finalData;
    if (mode === 'generate') {
      L.info(obj, `Running generator: ${step.generator}`);
      finalData = runGenerator(step, rawData, idMaps);
      if (!Array.isArray(finalData)) {
        throw new Error(`Generator '${step.generator}' for ${obj} did not return an array`);
      }
    } else {
      finalData = working;
    }

    L.info(obj, `Processed record count: ${finalData.length}`);

    const recStart = Date.now();
    let idMap = {};
    let okCount = 0;
    let errCount = 0;

    if (effectiveDryRun) {
      const sample = finalData.slice(0, Math.min(3, finalData.length));
      L.info(obj, `DRY_RUN sample: ${JSON.stringify(sample)}`);
      okCount = finalData.length;
    } else {
      idMap = await insertAndMap(conn, obj, finalData, stepCfg, idMaps, constants);
      okCount = Object.keys(idMap).length;
      errCount = Math.max(0, finalData.length - okCount);
      upsertIdMap(idMaps, obj, idMap, { preferExisting: true });
    }

    const recEnd = Date.now();
    const summary = `ok=${okCount} errors=${errCount} elapsed=${ms(recStart, recEnd)}`;
    L.info(obj, `SUMMARY ✅ ${summary}`);

    runReport.steps.push({
      object: obj,
      dataFile: step.dataFile,
      dataKey: step.dataKey || '<root>',
      mode: (step.mode || 'direct').toLowerCase(),
      generator: step.generator || null,
      configFile: step.configFile,
      attempted: finalData.length,
      ok: okCount,
      errors: errCount,
      elapsedMs: recEnd - recStart,
    });
    runReport.totals.attempted += finalData.length;
    runReport.totals.insertedOrUpserted += okCount;
    runReport.totals.errors += errCount;
  }

  const totalEnd = Date.now();
  runReport.finishedAt = new Date(totalEnd).toISOString();
  runReport.totalElapsedMs = totalEnd - totalStart;

  return runReport;
}
