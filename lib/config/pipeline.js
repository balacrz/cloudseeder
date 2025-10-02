import fs from "fs";
import path from "path";
import { readJSON, deepMerge } from "./utils.js";

export function loadPipeline({
  configDir = path.resolve(process.cwd(), "config"),
  envName = process.env.LOADER_ENV || process.env.NODE_ENV || "dev",
} = {}) {
  const basePath = path.join(configDir, "pipeline.json");
  if (!fs.existsSync(basePath)) throw new Error(`Missing pipeline at ${basePath}`);
  const envPath = path.join(configDir, "env", envName, "pipeline.json");

  const base = readJSON(basePath);
  const env = fs.existsSync(envPath) ? readJSON(envPath) : {};
  return deepMerge({}, base, env);
}
