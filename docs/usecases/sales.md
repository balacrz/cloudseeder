# Use Case: Sales — Account, Contact, Opportunity

## Overview

This use case loads a standard B2B sales dataset: companies (Account), their employees (Contact), and open deals (Opportunity). It demonstrates the complete mapping DSL — field shaping, transforms, reference resolution, validation, and upsert strategy — across three related objects.

**Objects loaded:** Account → Contact, Opportunity (both depend on Account)

**Key patterns demonstrated:**
- Parent-first loading order via `dependsOn`
- Helper field cleanup with `transform.post`
- Optional references (`Primary_Contact__c`) with `onMissing: "null"`
- Sparse seeds with `coalesce` transform
- Constants for shared default values
- Bulk API for high-volume steps

---

## 1. Folder Structure

```
config/
├── constants.json
├── pipeline.json
└── sales/
    ├── data/
    │   └── seed.json
    └── mappings/
        ├── Account.json
        ├── Contact.json
        └── Opportunity.json
```

---

## 2. Constants (`config/constants.json`)

Shared defaults referenced in Opportunity mapping.

```json
{
  "oppty": {
    "defaultStageName": "Prospecting",
    "defaultCloseDate": "2025-09-30"
  }
}
```

---

## 3. Seed Data (`config/sales/data/seed.json`)

Each object key in the seed file maps to a pipeline `dataKey`.

```json
{
  "Account": [
    { "External_Id__c": "acct-001", "Name": "Acme Corp",           "Industry": "Technology" },
    { "External_Id__c": "acct-002", "Name": "Global Dynamics Inc",  "Industry": "Manufacturing" },
    { "External_Id__c": "acct-003", "Name": "Horizon Technologies", "Industry": "Technology" }
  ],

  "Contact": [
    { "External_Id__c": "cont-001", "FirstName": "Sam",   "LastName": "Lee",    "Email": "sam.lee@acme.com",    "AccountExternalId": "acct-001" },
    { "External_Id__c": "cont-002", "FirstName": "Maria",                       "Email": "maria@globaldyn.com", "AccountExternalId": "acct-002" },
    { "External_Id__c": "cont-003", "FirstName": "David", "LastName": "Chen",   "Email": "david@horizontech.net","AccountExternalId": "acct-003" }
  ],

  "Opportunity": [
    { "External_Id__c": "opp-001", "Name": "Acme – Starter Deal",    "StageName": "Qualification", "CloseDate": "2025-10-15", "Amount": 15000,  "AccountExternalId": "acct-001", "PrimaryContactExternalId": "cont-001" },
    { "External_Id__c": "opp-002", "Name": "Global – Expansion",     "StageName": "Proposal/Price Quote",                    "Amount": 75000,  "AccountExternalId": "acct-002" },
    { "External_Id__c": "opp-003", "Name": "Horizon – New License",                                "CloseDate": "2025-12-01", "ExpectedRevenue": 45000, "AccountExternalId": "acct-003", "PrimaryContactExternalId": "cont-003" }
  ]
}
```

**Seed design notes:**
- `External_Id__c` is the stable match key for idempotent upserts.
- `AccountExternalId` is a helper field — it links Contacts/Opportunities to their parent Account. It is removed before committing to Salesforce.
- `PrimaryContactExternalId` is optional — some Opportunities omit it.
- Opportunity `opp-002` omits `CloseDate` (falls back to constant). `opp-003` omits `StageName` (falls back to constant) and provides `ExpectedRevenue` instead of `Amount` (coalesced by transform).

---

## 4. Pipeline (`config/pipeline.json`)

```json
{
  "dryRun": false,
  "steps": [
    {
      "object":     "Account",
      "dataFile":   "./config/sales/data/seed.json",
      "dataKey":    "Account",
      "mode":       "direct",
      "configFile": "./config/sales/mappings/Account.json",
      "dependsOn":  []
    },
    {
      "object":     "Contact",
      "dataFile":   "./config/sales/data/seed.json",
      "dataKey":    "Contact",
      "mode":       "direct",
      "configFile": "./config/sales/mappings/Contact.json",
      "dependsOn":  ["Account"]
    },
    {
      "object":     "Opportunity",
      "dataFile":   "./config/sales/data/seed.json",
      "dataKey":    "Opportunity",
      "mode":       "direct",
      "configFile": "./config/sales/mappings/Opportunity.json",
      "dependsOn":  ["Account", "Contact"]
    }
  ]
}
```

**Why `Opportunity` depends on both `Account` and `Contact`?**
The optional `Primary_Contact__c` lookup resolves from `idMaps.Contact`. If Contact loaded after Opportunity, the reference would fail. Declaring both dependencies guarantees correct ordering.

---

## 5. Mapping Files

### 5.1 Account (`config/sales/mappings/Account.json`)

Account has no parent reference — it is the root object.

```json
{
  "identify": { "matchKey": "External_Id__c" },

  "shape": {
    "fieldMap": {},
    "defaults": {
      "Type":     "Customer",
      "Industry": "Other"
    },
    "removeFields": []
  },

  "transform": {
    "pre": [
      { "op": "coalesce", "out": "Name", "from": ["Name", "CompanyName"], "default": "Unnamed Account" }
    ],
    "post": []
  },

  "references": [],

  "validate": {
    "requiredFields": ["Name", "External_Id__c"],
    "uniqueBy": ["External_Id__c"]
  },

  "strategy": {
    "operation":       "upsert",
    "externalIdField": "External_Id__c",
    "api":             "bulk",
    "batchSize":       200
  }
}
```

**Highlights:**
- `coalesce` in `pre` transform: seeds may provide either `Name` or `CompanyName`; the first non-empty value wins.
- `defaults` set `Type` and `Industry` when absent, so Salesforce required-field validation always passes.
- Bulk API is used because this step can scale to thousands of accounts.

---

### 5.2 Contact (`config/sales/mappings/Contact.json`)

Contact links to Account via `AccountId`. The helper field `AccountExternalId` is removed after reference resolution.

```json
{
  "identify": { "matchKey": "External_Id__c" },

  "shape": {
    "fieldMap": {},
    "defaults": {},
    "removeFields": []
  },

  "transform": {
    "pre": [
      { "op": "coalesce", "out": "LastName", "from": ["LastName", "Name"], "default": "Unknown" }
    ],
    "post": [
      { "op": "remove", "field": "AccountExternalId" }
    ]
  },

  "references": [
    {
      "field":     "AccountId",
      "refObject": "Account",
      "refKey":    "${AccountExternalId}",
      "required":  true
    }
  ],

  "validate": {
    "requiredFields": ["External_Id__c", "LastName", "AccountId"],
    "uniqueBy": ["External_Id__c"]
  },

  "strategy": {
    "operation":       "upsert",
    "externalIdField": "External_Id__c",
    "api":             "rest",
    "batchSize":       200
  }
}
```

**Highlights:**
- `coalesce` in `pre`: handles seeds that only have `Name` (full name) instead of `LastName`. Ensures Salesforce required field is always populated.
- `transform.post` removes `AccountExternalId` after the reference resolver has used it.
- `references[].refKey` uses `${AccountExternalId}` — the `${}` interpolates the current record's seed value, not a field name literal.

---

### 5.3 Opportunity (`config/sales/mappings/Opportunity.json`)

Opportunity links to Account (required) and Contact (optional via custom field).

```json
{
  "identify": { "matchKey": "External_Id__c" },

  "shape": {
    "fieldMap": {},
    "defaults": {
      "StageName": "${constants.oppty.defaultStageName}",
      "CloseDate":  "${constants.oppty.defaultCloseDate}"
    },
    "removeFields": []
  },

  "transform": {
    "pre": [
      { "op": "coalesce", "out": "Amount", "from": ["Amount", "ExpectedRevenue"], "default": 0 }
    ],
    "post": [
      { "op": "remove", "field": "AccountExternalId" },
      { "op": "remove", "field": "PrimaryContactExternalId" }
    ]
  },

  "references": [
    {
      "field":     "AccountId",
      "refObject": "Account",
      "refKey":    "${AccountExternalId}",
      "required":  true
    },
    {
      "field":     "Primary_Contact__c",
      "refObject": "Contact",
      "refKey":    "${PrimaryContactExternalId}",
      "required":  false,
      "onMissing": "null"
    }
  ],

  "validate": {
    "requiredFields": ["External_Id__c", "Name", "StageName", "CloseDate", "AccountId"],
    "uniqueBy": ["External_Id__c"]
  },

  "strategy": {
    "operation":       "upsert",
    "externalIdField": "External_Id__c",
    "api":             "bulk",
    "batchSize":       200
  }
}
```

**Highlights:**
- `defaults` use `${constants.*}` tokens so defaults can be changed centrally without editing the mapping.
- `coalesce` for `Amount`: seeds that only provide `ExpectedRevenue` still produce a valid `Amount`.
- Optional `Primary_Contact__c`: `onMissing: "null"` sets the field to null rather than throwing. Seeds that don't provide `PrimaryContactExternalId` still load successfully.
- Both helper columns removed in `post` transform so they never reach Salesforce.

---

## 6. Execution Flow

```
Step 1: Account (bulk upsert)
  → idMaps.Account["acct-001"] = "001xxxx"
  → idMaps.Account["acct-002"] = "001yyyy"
  → ...

Step 2: Contact (rest upsert, depends on Account)
  → AccountExternalId "acct-001" → idMaps.Account["acct-001"] → AccountId: "001xxxx"
  → idMaps.Contact["cont-001"] = "003aaaa"
  → ...

Step 3: Opportunity (bulk upsert, depends on Account + Contact)
  → AccountExternalId "acct-001" → AccountId: "001xxxx"
  → PrimaryContactExternalId "cont-001" → Primary_Contact__c: "003aaaa"
  → ...
```

---

## 7. Validation Checklist

- Every seed row has a stable `External_Id__c`.
- `AccountExternalId` links every Contact and Opportunity to its parent Account.
- `LastName` is guaranteed by `coalesce` even for seeds without it.
- `StageName` and `CloseDate` are guaranteed by `constants` defaults.
- `Amount` is guaranteed by `coalesce` from `ExpectedRevenue`.
- Helper fields (`AccountExternalId`, `PrimaryContactExternalId`) are removed before commit.
- Salesforce required fields are listed in `validate.requiredFields`.

---

## 8. Operational Tips

| Scenario | What to do |
|---|---|
| Re-run without duplicates | Use `upsert` with `externalIdField` — existing records are updated, not re-inserted |
| Preview changes before writing | Set `DRY_RUN=true` — transforms, references, and validation all run; API calls are skipped |
| Seed new fields without touching existing ones | Add to `shape.defaults` for sparse seeds, or use `transform.pre` assign to hard-code values |
| Large dataset (10k+ records) | Use `"api": "bulk"` and tune `batchSize`; set `strategy.pollTimeoutMs` if jobs are slow |
| Debug reference resolution failures | Set `DEBUG_REFS=true` — prints each lookup key, resolved value, and onMissing behavior |
| Add environment-specific defaults | Create `config/env/<ENV_NAME>/Opportunity.json` with only the fields to override |
