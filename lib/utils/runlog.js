// lib/utils/runlog.js
import fs from "fs";
import path from "path";

const ts = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

function line(tag, msg) {
  return `[${ts()}]${tag ? ` [${tag}]` : ""} ${msg}`;
}

/**
 * Creates a single log file per run:
 *   logs/run-YYYYMMDD_HHMMSSZ.log
 */
export function createRunLogSingle(baseDir = "logs") {
  const runId = `run-${stamp()}`;
  const logsDir = path.join(process.cwd(), baseDir);
  const filePath = path.join(logsDir, `${runId}.log`);
  fs.mkdirSync(logsDir, { recursive: true });

  const stream = fs.createWriteStream(filePath, { flags: "a" });

  return {
    runId,
    path: filePath,
    write(tag, msg) {
      stream.write(line(tag, msg) + "\n");
    },
    writeJson(tag, label, obj) {
      stream.write(line(tag, `${label} >>>`) + "\n");
      stream.write(JSON.stringify(obj, null, 2) + "\n");
      stream.write(line(tag, "<<< END JSON") + "\n");
    },
    close() {
      try { stream.end(); } catch (_) {}
    },
  };
}
