# CloudSeeder — Configuration & API Reference

CloudSeeder is a Node.js CLI tool that loads declaratively-configured seed data into Salesforce orgs. It reads JSON pipeline definitions, applies field mappings and data transformations, resolves parent-child foreign-key references, and writes records via the REST, Composite, or Bulk API 2.0.

For installation and running instructions, see [setup.md](setup.md).

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [Pipeline Config Reference](#pipeline-config-reference)
3. [Mapping Config Reference](#mapping-config-reference)
4. [Constants](#constants)
5. [Filters](#filters)
6. [Transforms](#transforms)
7. [Reference Resolution](#reference-resolution)
8. [Generators](#generators)
9. [Environment Overlays](#environment-overlays)
10. [Environment Variables](#environment-variables)
11. [Metadata Validation & Caching](#metadata-validation--caching)
12. [API Strategies](#api-strategies)
13. [Dry Run Mode](#dry-run-mode)
14. [Logging](#logging)
15. [Error Handling](#error-handling)
16. [Project Structure](#project-structure)
17. [Use Cases](#use-cases)

---

## How It Works

### Execution Flow

```
.env + config/pipeline.json
        │
        ▼
Authenticate to Salesforce
        │
        ▼
Snapshot org metadata (describe all objects)
        │
        ▼
Validate / auto-create external ID fields
        │
        ▼
Topological sort steps by dependsOn
        │
        ▼  for each step:
┌──────────────────────────────────────────────────┐
│  1.  Load mapping config (4-level merge)         │
│  2.  Load seed records from dataFile/dataKey     │
│  3.  Apply filter predicate (subset records)     │
│  4.  Generate records if mode=generate           │
│  5.  resolveConstantsDeep on config + records    │
│  6.  Per record:                                 │
│       a. Pre-transforms                          │
│       b. Shape: fieldMap, defaults, removeFields │
│       c. Resolve references → Salesforce IDs     │
│       d. Post-transforms                         │
│  7.  Prune fields not in org schema              │
│  8.  Validate required fields + uniqueBy         │
│  9.  Chunk into batches of batchSize             │
│ 10.  Commit to Salesforce (REST/Composite/Bulk)  │
│ 11.  Build idMap: externalKey → Salesforce ID    │
└──────────────────────────────────────────────────┘
        │
        ▼
idMaps passed to all subsequent steps
        │
        ▼
Write final JSON run report to log file
```

### idMaps

After each step completes, CloudSeeder records the mapping of external key → Salesforce ID in a global `idMaps` store. All subsequent steps can look up IDs from any previously completed object. For example, once Account is seeded, every Contact and Opportunity step automatically resolves `AccountId` from `idMaps.Account`.

---

## Pipeline Config Reference

**Location:** `config/pipeline.json`

```jsonc
{
  "dryRun": false,          // optional: pipeline-level dry run flag
  "steps": [
    {
      "object":       "Account",
      "dataFile":     "./config/sales/data/seed.json",
      "dataKey":      "Account",
      "mode":         "direct",
      "configFile":   "./config/sales/mappings/Account.json",
      "dependsOn":    [],
      "filter":       null,
      "configInline": null
    },
    {
      "object":    "Contact",
      "dataFile":  "./config/sales/data/seed.json",
      "dataKey":   "Contact",
      "mode":      "direct",
      "configFile":"./config/sales/mappings/Contact.json",
      "dependsOn": ["Account"]
    }
  ]
}
```

### Step Fields

| Field | Required | Description |
|---|---|---|
| `object` | Yes | Salesforce API object name (e.g., `Account`, `My_Object__c`) |
| `dataFile` | Yes | Path to seed data JSON/JSON5 file (relative to repo root) |
| `dataKey` | No | Key within the data file. Omit if file root is a plain array. |
| `mode` | No | `"direct"` (default) or `"generate"` |
| `configFile` | Yes | Path to the object mapping config |
| `dependsOn` | No | Array of object names that must complete before this step runs |
| `filter` | No | Declarative filter predicate(s) to subset records before processing |
| `generator` | No | Generator function name — only used when `mode: "generate"` |
| `configInline` | No | Inline mapping config overrides — highest precedence in the merge chain |

### Dependency Resolution

Steps are topologically sorted by `dependsOn` using Kahn's algorithm before execution. Steps at the same dependency depth preserve their original JSON order. If a cyclic dependency is detected, CloudSeeder logs a warning and falls back to original step order rather than aborting.

---

## Mapping Config Reference

Each step's `configFile` is a JSON file that describes how to transform seed records before committing them. All sections are optional except `identify`.

```jsonc
{
  "identify": {
    "matchKey": "External_Id__c"    // field used as idMap index and upsert external ID
  },
  "shape": {
    "fieldMap":     { "OldName": "NewName" },
    "defaults":     { "Type": "Customer", "StageName": "${constants.oppty.defaultStageName}" },
    "removeFields": ["HelperColumn"]
  },
  "transform": {
    "pre":  [],                      // operations applied before reference resolution
    "post": [
      { "op": "remove", "field": "AccountExternalId" }
    ]
  },
  "references": [
    {
      "field":     "AccountId",
      "refObject": "Account",
      "refKey":    "${AccountExternalId}",
      "required":  true,
      "onMissing": "error"
    }
  ],
  "validate": {
    "requiredFields": ["Name", "External_Id__c"],
    "uniqueBy":       ["External_Id__c"]
  },
  "strategy": {
    "operation":       "upsert",
    "externalIdField": "External_Id__c",
    "api":             "bulk",
    "batchSize":       200,
    "pollTimeoutMs":   600000,
    "pollIntervalMs":  2000
  }
}
```

### Config Merge Order

Mapping configs are merged from four sources. Higher entries override lower ones:

| Precedence | Source |
|---|---|
| Lowest | `config/base/<Object>.json` — shared defaults applied to all environments |
| ↑ | `config/env/<ENV_NAME>/<Object>.json` — environment-specific override |
| ↑ | `step.configFile` — the primary per-step mapping config |
| Highest | `step.configInline` — inline overrides in `pipeline.json` |

Plain objects are deep-merged. Arrays are replaced, not merged.

Configs are memoized per process run — identical (object, paths, envName, inline) combos are loaded once.

### `identify`

| Field | Description |
|---|---|
| `matchKey` | External ID field used as the key in `idMap` and as the upsert external ID field. Must exist in the org (or `AUTO_CREATE_MATCH_KEYS=true`). |

### `shape`

| Field | Description |
|---|---|
| `fieldMap` | Rename fields before committing: `{ "SeedFieldName": "SalesforceFieldName" }` |
| `defaults` | Set a field value only when that field is absent or undefined in the record. Supports `${constants.*}` tokens. |
| `removeFields` | Drop these fields from the record before committing (e.g., universal helper columns like `_type` or `_debug`). |

### `validate`

| Field | Description |
|---|---|
| `requiredFields` | These fields must be present and non-empty on every record after all transforms. A missing field causes a fatal error. |
| `uniqueBy` | Client-side uniqueness check across these fields before committing. Duplicates cause a fatal error. |

### `strategy`

| Field | Default | Description |
|---|---|---|
| `operation` | `"upsert"` | `"insert"` or `"upsert"` |
| `externalIdField` | — | Salesforce External ID API field name. Required for upsert. |
| `api` | `"rest"` | `"rest"`, `"composite"`, or `"bulk"` |
| `batchSize` | `200` | Records per API batch |
| `pollTimeoutMs` | `600000` | Bulk only: job polling timeout in ms (10 min) |
| `pollIntervalMs` | `2000` | Bulk only: polling interval in ms |

---

## Constants

**Location:** `config/constants.json`

Constants are shared values you can reference anywhere in mapping configs or seed data using `${constants.<dot.path>}` syntax.

```json
{
  "oppty": {
    "defaultStageName": "Prospecting",
    "defaultCloseDate":  "2025-09-30"
  },
  "account": {
    "defaultType": "Customer"
  }
}
```

**Usage in a mapping default:**

```json
"defaults": {
  "StageName": "${constants.oppty.defaultStageName}",
  "CloseDate":  "${constants.oppty.defaultCloseDate}"
}
```

**Usage in seed data values:**

```json
{ "StageName": "${constants.oppty.defaultStageName}" }
```

Constants are resolved recursively through the entire config object and each seed record before any transforms run. Per-environment overrides are loaded from `config/env/<ENV_NAME>/constants.json` and deep-merged over the base.

---

## Filters

Filters subset seed records before processing. Applied at the step level via `step.filter`. If no filter is specified, all records are used.

### Simple Predicates

| Predicate | Example | Matches when |
|---|---|---|
| `exists` | `{ "exists": "ParentId" }` | Field is present and non-null |
| `missing` | `{ "missing": "ParentId" }` | Field is absent or null |
| `equals` | `{ "equals": { "field": "Level", "value": 2 } }` | Field equals value (add `"ci": true` for case-insensitive) |
| `neq` | `{ "neq": { "field": "Status", "value": "Closed" } }` | Field does not equal value |
| `in` | `{ "in": { "field": "Type", "values": ["A","B"] } }` | Field value is in the list |
| `nin` | `{ "nin": { "field": "Type", "values": ["X"] } }` | Field value is not in the list |
| `regex` | `{ "regex": { "field": "Code", "pattern": "^PROD-", "flags": "i" } }` | Field matches regular expression |
| `gt` | `{ "gt": { "field": "Amount", "value": 1000 } }` | Field > value |
| `gte` | `{ "gte": { "field": "Amount", "value": 1000 } }` | Field >= value |
| `lt` | `{ "lt": { "field": "Amount", "value": 5000 } }` | Field < value |
| `lte` | `{ "lte": { "field": "Amount", "value": 5000 } }` | Field <= value |
| `contains` | `{ "contains": { "field": "Name", "value": "Corp" } }` | String contains substring |
| `startsWith` | `{ "startsWith": { "field": "Code", "value": "PROD" } }` | String starts with prefix |
| `endsWith` | `{ "endsWith": { "field": "Code", "value": "-MRI" } }` | String ends with suffix |
| `length` | `{ "length": { "field": "Name", "op": "gt", "value": 3 } }` | String length comparison (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`) |
| `expr` | `{ "expr": "rec.Amount > 0 && rec.Stage !== 'Closed'" }` | Inline JS expression (receives `rec`, `ctx`) |

### Compound Predicates

```json
{ "all": [ { "exists": "AccountExternalId" }, { "missing": "IsDeleted" } ] }
```
```json
{ "any": [ { "equals": { "field": "Type", "value": "A" } }, { "equals": { "field": "Type", "value": "B" } } ] }
```
```json
{ "not": { "equals": { "field": "Status", "value": "Inactive" } } }
```

An array of predicates at the top level is treated as `all` (AND).

---

## Transforms

Transforms are applied as an ordered array of operations in two stages: `pre` (before reference resolution) and `post` (after). Use `post` to remove helper fields like `AccountExternalId` that you needed for reference resolution but don't want committed to Salesforce.

### Transform Operations

| `op` | Required fields | Description |
|---|---|---|
| `assign` | `field`, `value` | Set `field` to a literal `value` |
| `copy` | `from`, `to` | Copy value of `from` field to `to` field (source preserved) |
| `rename` | `from`, `to` | Move value to `to` and delete the source field |
| `remove` | `field` | Delete the field from the record entirely |
| `coalesce` | `fields`, `to` | Write the first non-empty value from `fields` array to `to`; supports an optional `default` |
| `concat` | `fields`, `to`, `sep` | Join the values of `fields` with `sep` separator into `to` |

### Example: Cleaning up helper fields

```json
"transform": {
  "pre": [
    { "op": "assign", "field": "RecordTypeId", "value": "012000000000001" }
  ],
  "post": [
    { "op": "remove", "field": "AccountExternalId" },
    { "op": "remove", "field": "ContactExternalId" }
  ]
}
```

### Example: Coalesce with fallback

```json
{ "op": "coalesce", "fields": ["PreferredName", "FirstName"], "to": "FirstName", "default": "Unknown" }
```

---

## Reference Resolution

References populate Salesforce lookup fields using IDs from prior steps' `idMaps`. They are declared in the `references` array of a mapping config and resolved after pre-transforms and shaping.

```json
"references": [
  {
    "field":     "AccountId",
    "refObject": "Account",
    "refKey":    "${AccountExternalId}",
    "required":  true,
    "onMissing": "error"
  }
]
```

### Reference Entry Fields

| Field | Type | Description |
|---|---|---|
| `field` | string | Target Salesforce lookup field to populate |
| `refObject` | string | Object name in `idMaps` to look up. If omitted, inferred from `field` (e.g., `AccountId` → `Account`, `ParentId` → current object). |
| `refKey` | string \| string[] | The lookup key. Supports `${fieldName}` template syntax resolved against the current record. Array form tries each in order and uses first non-empty. |
| `required` | boolean | If `true`, a missing key throws a fatal error (default: `true`) |
| `onMissing` | string | `"error"` (default) \| `"null"` (set field to null) \| `"skip"` (omit field entirely) |

### `refKey` Template Syntax

`${fieldName}` is replaced with the value of that field on the current seed record at resolution time. You can compose a key from multiple fields:

```json
{ "refKey": "${ParentCode}-${Level}" }
```

### Legacy `from` Syntax

The older `"from": "idMaps.<Object>['${keyField}']"` format is still supported for backwards compatibility.

### Debugging References

Set `DEBUG_REFS=true` to print every reference resolution attempt to console debug output.

---

## Generators

When a step sets `"mode": "generate"`, CloudSeeder calls a named generator function instead of reading from a seed array. Generators produce records dynamically — typically for junction objects or synthetic patterns that depend on IDs from prior steps.

```json
{
  "object":    "Junction__c",
  "mode":      "generate",
  "generator": "generateExpertLocationJunctions",
  "dataFile":  "./config/myproject/data/seed.json",
  "configFile":"./config/myproject/mappings/Junction__c.json",
  "dependsOn": ["Expert__c", "Location__c"]
}
```

### Registering a Generator

Add named functions to `services/generators.js`:

```js
export const generators = {
  myCustomGenerator(data, idMaps) {
    // data: full parsed content of step.dataFile
    // idMaps: accumulated { ObjectName: { externalKey: salesforceId } }
    return [/* array of plain record objects */];
  }
};
```

### Built-in Generators

| Name | Description |
|---|---|
| `generateExpertLocationJunctions` | Creates junction records between `BKAI__Expert__c` and `BKAI__Location__c` using resolved IDs from idMaps |
| `generateShiftPatternsPerLocation` | Clones each shift pattern template for every location, resolving location IDs from idMaps |
| `generateChildLocationsWithHierarchy` | Filters location records with a parent, replaces seed parent IDs with resolved Salesforce IDs |

---

## Environment Overlays

CloudSeeder supports per-environment configuration through an overlay system. All overlays are optional — any layer that doesn't exist is simply skipped.

```
config/
├── pipeline.json               # base pipeline (all envs)
├── constants.json              # base constants (all envs)
├── base/
│   └── Account.json            # base mapping applied across all envs
└── env/
    └── prod/
        ├── pipeline.json       # overrides pipeline for "prod"
        ├── constants.json      # overrides constants for "prod"
        └── Account.json        # overrides Account mapping for "prod"
```

Set `ENV_NAME=prod` to activate the `prod` overlay. `ENV_NAME` is resolved from: `LOADER_ENV` → `NODE_ENV` → `"dev"`.

### Overlay Merge Rules

- Pipeline and constants: shallow merge (env version replaces base keys)
- Mapping configs: deep merge for objects, array replacement
- Inline (`configInline`) always wins

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SF_LOGIN_URL` | Yes | — | `https://login.salesforce.com` or custom My Domain URL |
| `SF_USERNAME` | Yes | — | Salesforce username |
| `SF_PASSWORD` | Yes | — | Password + security token concatenated (no space) |
| `ENV_NAME` | No | `"dev"` | Selects `config/env/<ENV_NAME>/` overlays |
| `DRY_RUN` | No | `false` | Process and transform records but skip all Salesforce API writes |
| `REFRESH_METADATA` | No | `false` | Re-fetch and overwrite cached object describe snapshots |
| `AUTO_CREATE_MATCH_KEYS` | No | `false` | Auto-create the external ID field if it doesn't exist in the org |
| `LOG_LEVEL` | No | `info` | `error` \| `warn` \| `info` \| `debug` |
| `LOG_PRUNE` | No | `false` | Log the names of fields pruned by metadata validation (first 2 records per step) |
| `DEBUG_REFS` | No | `false` | Emit detailed reference resolution traces to console |

Variables can be set in a `.env` file at the project root or exported in the shell. Shell exports take precedence over `.env`.

---

## Metadata Validation & Caching

### What It Does

On the first run, CloudSeeder calls `describe()` on every Salesforce object in the pipeline and caches the result under `meta-data/<ORG_ID>/`. Subsequent runs use the cache.

The metadata is used to:

1. **Prune fields** — fields that don't exist in the org or aren't writable for the given operation (insert/upsert) are removed from records before committing. This prevents API errors from unrecognized field names.
2. **Validate match keys** — confirms that each step's `identify.matchKey` field exists as a valid external ID field in the org.
3. **Auto-create match keys** — if `AUTO_CREATE_MATCH_KEYS=true` and the match key field doesn't exist, CloudSeeder creates a Text(255), unique, external ID field via the Metadata API, grants field-level security via a Permission Set, and re-snapshots the object metadata.

### Cache Management

```bash
# Force re-fetch metadata on next run
REFRESH_METADATA=true npm start

# Auto-create any missing external ID fields
AUTO_CREATE_MATCH_KEYS=true npm start
```

Cache files are stored at `meta-data/<ORG_ID>/<ObjectApiName>.json`. Each file is a raw Salesforce `describe` response.

### Concurrency

Metadata snapshot calls are limited to 2 parallel requests to avoid hitting API rate limits.

---

## API Strategies

Select the strategy per step with `strategy.api`.

### REST (`"api": "rest"`)

Uses jsforce `sobject().insert()` or `.upsert()`. After upsert, queries the org with a `$in` SOQL to verify committed records. Best for small to medium batches.

### Composite (`"api": "composite"`)

Currently falls back to sequential per-record REST calls. A single-request Salesforce Composite API call is not yet implemented. Behavior is functionally equivalent to REST for now.

### Bulk 2.0 (`"api": "bulk"`)

Uses jsforce `conn.bulk2.loadAndWaitForResults()`. jsforce handles CSV encoding internally. CloudSeeder aligns results by external ID (upsert) or position (insert). After commit, queries the org to verify records (non-fatal if the verification query fails). Best for high-volume steps (hundreds to thousands of records).

| Strategy | `strategy.api` | Operations | Best for |
|---|---|---|---|
| REST | `"rest"` | `insert`, `upsert` | Small/medium batches; immediate feedback |
| Composite | `"composite"` | `insert`, `upsert` | Same as REST (fallback behavior) |
| Bulk 2.0 | `"bulk"` | `insert`, `upsert` | High-volume; tolerant of longer poll times |

---

## Dry Run Mode

Enable with `DRY_RUN=true` (env var) or `"dryRun": true` in `pipeline.json`.

In dry run mode, CloudSeeder:

- Loads seed data and applies all filters
- Runs the full transform pipeline: constants resolution, pre-transforms, shaping, reference resolution, post-transforms
- Validates required fields and uniqueness constraints
- **Does not call any Salesforce write APIs**
- Prints shaped payloads and reference resolution results to the console

Use dry run to validate a new pipeline config before touching an org, or to debug transform behavior without incurring API governor limits.

---

## Logging

### Console Output

Every log line follows the format:

```
[<ISO8601 timestamp>] [<object/module>] <message>
```

Log verbosity is controlled by the `LOG_LEVEL` environment variable. Levels from lowest to highest: `error`, `warn`, `info`, `debug`. Only messages at or below the current level are printed.

### Run Log File

Each run creates a new file at `logs/run-YYYYMMDD_HHMMSSZ.log` (UTC timestamp). The file contains:

- Run start event with `ENV`, `DRY_RUN` values
- Per-step summaries: records attempted, ok, failed, elapsed ms
- Final JSON run report block

```
[2025-01-01T12:00:00.000Z] [System] Start — ENV=dev DRY_RUN=false
[2025-01-01T12:00:01.200Z] [SNAPSHOT] Complete ✅ orgId=00D...
[2025-01-01T12:00:02.100Z] [STEP:Account] START 🚀 #1 [Account]
[2025-01-01T12:00:05.400Z] [STEP:Account] SUMMARY ✅ ok=20 errors=0 elapsed=3,300 ms
[2025-01-01T12:00:07.100Z] [STEP:Contact] SUMMARY ✅ ok=20 errors=0 elapsed=1,700 ms
[2025-01-01T12:00:11.500Z] [STEP:Opportunity] SUMMARY ✅ ok=20 errors=0 elapsed=4,400 ms
[2025-01-01T12:00:11.600Z] [System] RUN REPORT >>>
{
  "env": "dev",
  "dryRun": false,
  "startedAt": "2025-01-01T12:00:00.000Z",
  "finishedAt": "2025-01-01T12:00:11.600Z",
  "totalElapsedMs": 11600,
  "steps": [
    { "object": "Account",     "attempted": 20, "ok": 20, "errors": 0, "elapsedMs": 3300 },
    { "object": "Contact",     "attempted": 20, "ok": 20, "errors": 0, "elapsedMs": 1700 },
    { "object": "Opportunity", "attempted": 20, "ok": 20, "errors": 0, "elapsedMs": 4400 }
  ],
  "totals": { "attempted": 60, "insertedOrUpserted": 60, "errors": 0 }
}
[2025-01-01T12:00:11.600Z] [System] <<< END JSON
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Salesforce auth failure | Run aborts; error logged to console |
| Object not in org (snapshot phase) | Fatal — logged to run log; process exits before any steps run |
| Missing `step.object` / `step.dataFile` / `step.configFile` | Fatal throw before the step executes |
| `step.configFile` not found on disk | `StepConfigError` thrown; run aborts |
| Cyclic `dependsOn` | Warning logged; original step order used; run continues |
| Missing required field (post-transform) | Fatal throw; run aborts |
| Client-side uniqueness violation | Fatal throw; run aborts |
| DML failure (per record) | Logged per failure; that record's idMap entry is not created; execution continues for remaining records and steps |
| Generator name not registered | Fatal throw: `"Unknown generator '...'"` |
| Bulk API verification query failure | Non-fatal; warning logged; execution continues |
| Top-level unhandled rejection | Error written to run log and `console.error`; `process.exit(1)` |

---

## Project Structure

```
cloudseeder/
├── scripts/
│   └── runLoad.js                # CLI entry point and orchestrator
├── lib/
│   ├── loader.js                 # Per-step transform + commit pipeline (insertAndMap)
│   ├── filters.js                # Declarative record filter engine
│   ├── config/
│   │   ├── index.js              # Re-exports all config loaders
│   │   ├── pipeline.js           # Load pipeline.json with env overlay
│   │   ├── constants.js          # Load constants.json with env overlay
│   │   ├── step-config.js        # 4-level mapping config merge + memoization
│   │   ├── env.js                # Environment variable helpers
│   │   └── utils.js              # JSON5 reader, deepMerge
│   ├── pipeline/
│   │   ├── orchestrator.js       # Pipeline orchestration logic
│   │   ├── dataloader.js         # Data loading and batching
│   │   ├── generators.js         # Built-in generator dispatch
│   │   └── toposort.js           # Kahn's algorithm topological sort
│   ├── salesforce/
│   │   ├── auth.js               # Salesforce login via jsforce
│   │   ├── commit.js             # REST / Composite / Bulk commit strategies
│   │   ├── metadata.js           # Metadata snapshot, pruning, validation
│   │   └── permset.js            # Permission Set + FLS management
│   ├── transform/
│   │   ├── index.js              # Re-exports transform functions
│   │   ├── shape.js              # shapeRecord: fieldMap, defaults, removeFields
│   │   ├── transforms.js         # applyTransforms: assign/copy/rename/remove/coalesce/concat
│   │   ├── constants.js          # resolveConstantsDeep: ${constants.*} interpolation
│   │   └── ref-solver.js         # Foreign key reference resolution engine
│   ├── utils/
│   │   ├── logger.js             # Leveled console logger (ISO timestamps, module tags)
│   │   ├── duallogger.js         # Console + file dual logger
│   │   ├── runlog.js             # Per-run append-mode file logger
│   │   └── runcontext.js         # Runtime singleton: org ID
│   └── validators/
│       └── validatematchkeys.js  # Pre-run match key existence validation + auto-create
├── services/
│   └── generators.js             # Custom data generators (register new generators here)
├── config/
│   ├── pipeline.json
│   ├── constants.json
│   └── sales/
│       ├── data/seed.json
│       └── mappings/
│           ├── Account.json
│           ├── Contact.json
│           └── Opportunity.json
├── meta-data/                    # (generated) Object describe cache per org
│   └── <ORG_ID>/
│       └── <Object>.json
└── logs/                         # (generated) Per-run log files
    └── run-YYYYMMDD_HHMMSSZ.log
```

---

## Use Cases

Detailed, end-to-end examples with seed data, pipeline config, mapping files, and execution flow:

| Use Case | File | Objects |
|---|---|---|
| Sales pipeline | [usecases/sales.md](usecases/sales.md) | Account, Contact, Opportunity |
| Product hierarchy | [usecases/producthierarchy.md](usecases/producthierarchy.md) | Product2 (3-level), Pricebook2, PricebookEntry |

Each use case document includes the complete seed data, pipeline config, mapping files for every object, step-by-step execution trace, and tips for adapting the pattern to other object models.
