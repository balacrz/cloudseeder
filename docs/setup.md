# CloudSeeder — Setup & Execution

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 | Uses native ES modules (`"type": "module"`) |
| npm ≥ 8 | Included with Node.js 18+ |
| Salesforce credentials | Username, password (+ security token), login URL |
| API-enabled Salesforce org | Target objects must be deployed to the org |
| External ID fields | One per object being seeded; can be auto-created (see below) |

---

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd cloudseeder

# Install dependencies
npm install
```

---

## Credentials

Create a `.env` file in the project root:

```env
SF_LOGIN_URL=https://login.salesforce.com
SF_USERNAME=you@yourorg.com
SF_PASSWORD=yourPasswordYourSecurityToken
```

`SF_PASSWORD` is your Salesforce password with the security token appended directly — no space, no separator.

For sandbox orgs, set `SF_LOGIN_URL=https://test.salesforce.com`.

---

## Running the Pipeline

```bash
npm start
```

This runs `node scripts/runLoad.js` against the pipeline defined in `config/pipeline.json`.

---

## Common Run Options

All options are set as environment variables, either in `.env` or prefixed on the command.

### Dry run — preview without writing to Salesforce

```bash
DRY_RUN=true npm start
```

Transforms run, payloads are printed, no API writes occur. Use this to validate a new pipeline config.

### Force metadata refresh

```bash
REFRESH_METADATA=true npm start
```

Re-fetches field descriptions from Salesforce and overwrites the local cache. Use this after adding or removing fields in the org.

### Auto-create missing external ID fields

```bash
AUTO_CREATE_MATCH_KEYS=true npm start
```

If a step's `matchKey` field doesn't exist in the org, CloudSeeder creates it (Text 255, unique, external ID), grants field-level security via a Permission Set, and assigns the Permission Set to the running user.

### Target a specific environment overlay

```bash
ENV_NAME=prod npm start
```

Activates config files under `config/env/prod/`. Useful for pointing the same pipeline at different orgs or with different constants.

### Verbose debug output

```bash
LOG_LEVEL=debug npm start
```

Prints all debug-level log lines. Useful for tracing transform and reference resolution behavior.

### Debug reference resolution

```bash
DEBUG_REFS=true npm start
```

Prints every reference resolution attempt — the key being looked up, the idMaps bucket, and whether it was found.

### Log pruned fields

```bash
LOG_PRUNE=true npm start
```

Logs the field names removed during metadata validation for the first two records of each step.

---

## Combining Options

Options can be combined:

```bash
DRY_RUN=true LOG_LEVEL=debug DEBUG_REFS=true npm start
```

```bash
ENV_NAME=staging REFRESH_METADATA=true npm start
```

---

## Output

### Console

Every line is prefixed with an ISO timestamp and a module tag:

```
[2025-01-01T12:00:00.000Z] [System] Authenticated to Salesforce ✅
[2025-01-01T12:00:01.200Z] [SNAPSHOT] Complete ✅ orgId=00D...
[2025-01-01T12:00:02.100Z] [STEP:Account] START 🚀
[2025-01-01T12:00:05.400Z] [STEP:Account] SUMMARY ✅ ok=20 errors=0 elapsed=3,300 ms
[2025-01-01T12:00:11.500Z] [System] Completed ✅ total=11,500 ms
```

### Log File

Each run writes a file to `logs/run-YYYYMMDD_HHMMSSZ.log` containing all console events plus a final JSON run report. Log files accumulate — they are not overwritten.

---

## Re-running

Re-running the same pipeline on an org that already contains the data performs upserts — existing records are updated, no duplicates are created. This is safe to do anytime.
