// lib/utils/duallogger.js
/**
 * Routes each log call to both a console logger and a file-write function.
 *
 * @param {object}   consoleLog - logger with .info/.warn/.error/.debug(tag, msg)
 * @param {Function} fileLog    - fileLog(tag, msg) function
 * @returns {object} dual logger with .info/.warn/.error/.debug(tag, msg)
 */
export function createDualLogger(consoleLog, fileLog) {
  return {
    info:  (tag, msg) => { consoleLog?.info?.(tag, msg);  fileLog?.(tag, msg); },
    warn:  (tag, msg) => { consoleLog?.warn?.(tag, msg);  fileLog?.(tag, msg); },
    error: (tag, msg) => { consoleLog?.error?.(tag, msg); fileLog?.(tag, msg); },
    debug: (tag, msg) => { consoleLog?.debug?.(tag, msg); fileLog?.(tag, msg); },
  };
}
