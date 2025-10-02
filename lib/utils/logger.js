// logger.js
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT = (process.env.LOG_LEVEL || 'info').toLowerCase();

const ts = () => new Date().toISOString();
const can = (lvl) => LEVELS[CURRENT] >= LEVELS[lvl];

const line = (obj, msg) => `[${ts()}]${obj ? ` [${obj}]` : ''} ${msg}`;

export const log = {
  info: (obj, msg) => can('info')  && console.log(line(obj, msg)),
  warn: (obj, msg) => can('warn')  && console.warn(line(obj, msg)),
  error:(obj, msg) => can('error') && console.error(line(obj, msg)),
  debug:(obj, msg) => can('debug') && console.debug(line(obj, msg)),

  stepStart(obj) {
    console.time(`${obj}:step`);
  },
  stepEnd(obj, summary='') {
    console.timeEnd(`${obj}:step`);
    console.log(line(obj, `— END — ${summary}`));
  },

  // helper to summarize batch results (jsforce style)
  summarizeResults(obj, records, results, keyField) {
    let ok = 0, fail = 0;
    results.forEach((r) => (r.success ? ok++ : fail++));
    console.log(line(obj, `Results: ✅ ${ok}  ❌ ${fail}`));
    if (fail) {
      results.forEach((r, i) => {
        if (!r.success) {
          const key = keyField && records[i] ? records[i][keyField] : `row#${i}`;
          const errs = (r.errors || []).map(e => e.message || e).join('; ');
          console.error(line(obj, `FAIL ${key}: ${errs}`));
        }
      });
    }
  }
};
