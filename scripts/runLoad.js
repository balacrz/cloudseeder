// scripts/runLoad.js
import 'dotenv/config'; // must be first: loads .env before any other module reads process.env
import path from 'path';
import { fileURLToPath } from 'url';

import { loadEnvConfig } from '../lib/config/env.js';
import { getConnection } from '../lib/salesforce/auth.js';
import { createRunLogSingle } from '../lib/utils/runlog.js';
import { log } from '../lib/utils/logger.js';
import { createDualLogger } from '../lib/utils/duallogger.js';
import { runPipeline } from '../lib/pipeline/orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = path.resolve(__dirname, '..');

let runLog = null;

async function main() {
  const cfg = loadEnvConfig();
  runLog = createRunLogSingle('logs');
  const fileLog = (tag, msg) => runLog.write(tag, msg);
  const L = createDualLogger(log, fileLog);

  L.info('System', `Start — ENV=${cfg.loader.envName} DRY_RUN=${cfg.loader.dryRun}`);

  let conn = null;
  if (!cfg.loader.dryRun) {
    conn = await getConnection(cfg.salesforce);
    L.info('System', 'Authenticated to Salesforce ✅');
  } else {
    L.info('System', 'DRY_RUN enabled — will not write to Salesforce');
  }

  const report = await runPipeline(conn, cfg, { cwd: CWD, L });

  runLog.writeJson('System', 'RUN REPORT', report);
  L.info('System', `Completed ✅ • logFile=${runLog.path}`);
  runLog.close();
}

main().catch(async (err) => {
  const msg = err?.message || err?.stack || String(err);
  if (runLog) {
    runLog.write('System', `ERROR❌ ${msg}`);
    runLog.close();
  }
  console.error(`[${new Date().toISOString()}] [System] ERROR❌:`, msg);
  await new Promise(res => setTimeout(res, 10));
  process.exit(1);
});
