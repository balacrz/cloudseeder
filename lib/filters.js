// lib/filter.js

/**
 * Config filter can be:
 *  - A single predicate object
 *  - An array of predicate objects (implicit AND)
 *  - A boolean (true -> no filter, false -> filter nothing)
 *
 * Predicates supported:
 *  exists, missing, equals, neq, in, nin, regex,
 *  gt, gte, lt, lte, contains, startsWith, endsWith, length,
 *  and logical wrappers: all, any, not
 */

function get(rec, pathStr) {
  if (!pathStr) return undefined;
  return pathStr.split(".").reduce((o, k) => (o ? o[k] : undefined), rec);
}

function toNum(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function str(val, ci) {
  if (val == null) return "";
  const s = String(val);
  return ci ? s.toLowerCase() : s;
}

export function matchPredicate(rec, spec) {
  // Logical wrappers
  if (spec.all) {
    const arr = Array.isArray(spec.all) ? spec.all : [spec.all];
    return arr.every((p) => matchPredicate(rec, p));
  }
  if (spec.any) {
    const arr = Array.isArray(spec.any) ? spec.any : [spec.any];
    return arr.some((p) => matchPredicate(rec, p));
  }
  if (spec.not) {
    return !matchPredicate(rec, spec.not);
  }

  // Atomic predicates
  if (spec.exists) {
    const v = get(rec, spec.exists);
    return v !== undefined && v !== null;
  }
  if (spec.missing) {
    const v = get(rec, spec.missing);
    return v === undefined || v === null;
  }
  if (spec.equals) {
    const { field, value, ci } = spec.equals;
    const v = get(rec, field);
    return ci ? str(v, true) === str(value, true) : v === value;
  }
  if (spec.neq) {
    const { field, value, ci } = spec.neq;
    const v = get(rec, field);
    return ci ? str(v, true) !== str(value, true) : v !== value;
  }
  if (spec.in) {
    const { field, values = [], ci } = spec.in;
    const v = get(rec, field);
    if (ci) {
      const hay = values.map((x) => str(x, true));
      return hay.includes(str(v, true));
    }
    return values.includes(v);
  }
  if (spec.nin) {
    const { field, values = [], ci } = spec.nin;
    const v = get(rec, field);
    if (ci) {
      const hay = values.map((x) => str(x, true));
      return !hay.includes(str(v, true));
    }
    return !values.includes(v);
  }
  if (spec.regex) {
    const { field, pattern, flags } = spec.regex;
    const v = get(rec, field);
    if (v == null) return false;
    const rx = new RegExp(pattern, flags || "");
    return rx.test(String(v));
  }
  if (spec.gt || spec.gte || spec.lt || spec.lte) {
    const op = spec.gt ? "gt" : spec.gte ? "gte" : spec.lt ? "lt" : "lte";
    const { field, value } = spec[op];
    const a = toNum(get(rec, field));
    const b = toNum(value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (op === "gt")  return a >  b;
    if (op === "gte") return a >= b;
    if (op === "lt")  return a <  b;
    if (op === "lte") return a <= b;
  }
  if (spec.contains) {
    const { field, value, ci } = spec.contains;
    const v = get(rec, field);
    if (v == null) return false;
    return str(v, ci).includes(str(value, ci));
  }
  if (spec.startsWith) {
    const { field, value, ci } = spec.startsWith;
    const v = get(rec, field);
    if (v == null) return false;
    return str(v, ci).startsWith(str(value, ci));
  }
  if (spec.endsWith) {
    const { field, value, ci } = spec.endsWith;
    const v = get(rec, field);
    if (v == null) return false;
    return str(v, ci).endsWith(str(value, ci));
  }
  if (spec.length) {
    const { field, op = "eq", value } = spec.length;
    const v = get(rec, field);
    const len = v == null ? 0 : String(v).length;
    if (op === "eq")  return len === value;
    if (op === "neq") return len !== value;
    if (op === "gt")  return len >  value;
    if (op === "gte") return len >= value;
    if (op === "lt")  return len <  value;
    if (op === "lte") return len <= value;
    return false;
  }

  // Unknown predicate => default to true (non-restrictive)
  return true;
}

export function applyFilter(records, filterSpec) {
  if (filterSpec === undefined || filterSpec === null || filterSpec === true) return records;
  if (filterSpec === false) return []; // filter nothing
  const preds = Array.isArray(filterSpec) ? filterSpec : [filterSpec];
  return records.filter((rec) => preds.every((p) => matchPredicate(rec, p)));
}
