// lib/mapping/ref-solver.js
// ESM module — no external deps.

/**
 * Infer the target sObject name from a lookup field name.
 * - "ParentId" -> currentObject
 * - "<Thing>Id" -> "Thing"
 * - Custom lookups like "Parent_Product__c" cannot be inferred: require refObject.
 */
export function inferTargetObject(field, currentObject) {
  if (field === "ParentId") return currentObject || null;
  if (field && field.endsWith("Id")) return field.slice(0, -2);
  return null; // e.g., custom lookup Parent_Product__c
}

/** Safe getter: supports "a.b.c" and "a[0].b" */
export function getByPath(obj, path) {
  if (!path || typeof path !== "string") return undefined;
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Replace ${...} from record paths */
function renderTemplate(tpl, record) {
  return String(tpl).replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const val = getByPath(record, expr.trim());
    return val == null ? "" : String(val);
  });
}

function firstNonEmpty(values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// Parse legacy "idMaps.Product2['${ProductExternalId}']"
function parseLegacyFrom(fromStr, record) {
  const m = String(fromStr).match(/^idMaps\.([A-Za-z0-9_]+)\[['"]([^'"]+)['"]\]$/);
  if (!m) return null;
  const [, obj, keyTpl] = m;
  const key = keyTpl.includes("${") ? renderTemplate(keyTpl, record) : keyTpl;
  return { targetObject: obj, key };
}

// Accept common aliases in case configs vary
function pickTemplate(entry) {
  return (
    entry.refKey ??
    entry.template ??
    entry.keyTemplate ??
    entry.compositeKeyTemplate ??
    null
  );
}

/**
 * Resolve a reference value (returns Salesforce Id | null | undefined).
 * Does not mutate the record.
 *
 * Entry supports:
 * {
 *   field: "Product2Id" | "Parent_Product__c",
 *   refKey?: "ParentExternalId" | ["ParentExternalId","Sku"],
 *   refKeyTemplate?: "P-${ParentExternalId}",
 *   refObject?: "Product2",          // required for custom lookups
 *   onMissing?: "error" | "null" | "skip" (default "error"),
 *   required?: boolean,
 *   from?: "idMaps.Product2['${ParentExternalId}']"  // legacy
 * }
 */
export function resolveRef(entry, record, idMaps, currentObject) {
  if (process.env.DEBUG_REFS === "true") {
    // Helpful when chasing undefineds
    console.debug("[ref] entry:", JSON.stringify(entry));
  }

  const {
    field,
    refKey,
    refObject,
    onMissing = "error",
    required = false,
    from // legacy
  } = entry;

  if (!field) throw new Error(`[ref] Entry missing 'field'.`);

  // Determine target object (bucket) in idMaps
  let targetObject = refObject || inferTargetObject(field, currentObject) || currentObject;
  // Compute lookup key
  let keyValue;

  // Legacy path
  if (from && typeof from === "string" && from.startsWith("idMaps.")) {
    const parsed = parseLegacyFrom(from, record);
    if (!parsed) {
      throw new Error(`[ref] Unsupported legacy 'from' expression for field "${field}": ${from}`);
    }
    targetObject = parsed.targetObject;
    keyValue = parsed.key;

  } else {
    // Declarative path
    const tpl = pickTemplate(entry);
    if (typeof tpl === "string") {
      keyValue = renderTemplate(tpl, record);
    } else if (Array.isArray(refKey)) {
      keyValue = firstNonEmpty(refKey.map((k) => getByPath(record, k)));
    } else if (typeof refKey === "string") {
      keyValue = getByPath(record, refKey);
    } else {
      throw new Error(
        `[ref] Field "${field}" must include 'refKey' (string|array) or 'refKeyTemplate'.`
      );
    }
  }

  const missingKey = keyValue == null || String(keyValue).trim() === "";
  if (missingKey) {
    if (required || onMissing === "error") {
      const usedTpl = pickTemplate(entry);
      throw new Error(
        `[ref] Missing key for field "${field}" (${usedTpl ? "refKeyTemplate" : "refKey"}).`
      );
    }
    if (onMissing === "null") return null;
    if (onMissing === "skip") return undefined;
  }

  // If still no target object (custom lookup), require refObject
  if (!targetObject) {
    throw new Error(
      `[ref] Cannot infer target object for field "${field}". Provide "refObject".`
    );
  }

  const bucket = idMaps?.[targetObject] || {};
  const resolved = bucket[keyValue];

  if (!resolved) {
    if (required || onMissing === "error") {
      throw new Error(
        `[ref] Not found: idMaps.${targetObject}["${keyValue}"] for field "${field}".`
      );
    }
    if (onMissing === "null") return null;
    if (onMissing === "skip") return undefined;
  }

  return resolved;
}

/**
 * Resolve all references for a single record (mutates and returns it).
 */
export function resolveReferences(rec, references = [], idMaps = {}, currentObject = null) {
  if (!Array.isArray(references) || references.length === 0) return rec;

  for (const entry of references) {
    if (!entry || typeof entry !== "object") continue;

    const val = resolveRef(entry, rec, idMaps, currentObject);

    // Only write when defined; allow null (explicit) and primitives/strings.
    if (val !== undefined) {
      rec[entry.field] = val;
    }
  }
  return rec;
}

export default { resolveReferences, resolveRef, inferTargetObject, getByPath };
