import fs from "fs";
import JSON5 from "json5";

export function readJSON(p) {
  const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""); // strip BOM
  return JSON5.parse(raw);
}

export function deepMerge(target, ...sources) {
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
