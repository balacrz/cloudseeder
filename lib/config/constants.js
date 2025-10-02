import fs from "fs";
import path from "path";
import { readJSON, deepMerge } from "./utils.js";

export function loadConstants({
  configDir = path.resolve(process.cwd(), "config"),
  envName = process.env.LOADER_ENV || process.env.NODE_ENV || "dev",
} = {}) {
  const basePath = path.join(configDir, "constants.json");
  const envPath = path.join(configDir, "env", envName, "constants.json");

  const base = fs.existsSync(basePath) ? readJSON(basePath) : {};
  const env = fs.existsSync(envPath) ? readJSON(envPath) : {};
  return deepMerge({}, base, env);
}
