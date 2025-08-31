# Sales Use Case – Account, Contact, and Opportunity

## 1. Introduction
This document describes how to configure **Sales (Account–Contact–Opportunity)** data loading using the Node.js Salesforce Data Loader. It demonstrates how seed data, pipelines, and mapping files work together to manage parent-child relationships, handle sparse data, enforce validations, and ensure idempotent loads.

---

## 2. Business Context
The Sales use case involves three primary objects:
- **Account** – Represents companies or organizations.
- **Contact** – Individuals tied to Accounts.
- **Opportunity** – Sales deals linked to Accounts.

The configuration must:
1. Load Accounts first (parents).
2. Associate Contacts with Accounts.
3. Create Opportunities tied to Accounts.
4. Handle missing values, defaults, references, and validation.

---

## 3. Seed Data (`sales.json`)
```json
{
  "Account": [
    { "BKAI__External_Id__c": "acct-001", "Name": "Acme Corp" },
    { "BKAI__External_Id__c": "acct-002", "Name": "GlobalTech" }
  ],
  "Contact": [
    { "BKAI__External_Id__c": "cont-001", "FirstName": "Sam", "LastName": "Lee", "Email": "sam.lee@acme.com", "AccountExternalId": "acct-001" },
    { "BKAI__External_Id__c": "cont-002", "FirstName": "Ava", "Email": "ava.chen@globaltech.com", "AccountExternalId": "acct-002" }
  ],
  "Opportunity": [
    { "BKAI__External_Id__c": "opp-001", "Name": "Acme – Starter Deal", "StageName": "Prospecting", "Amount": 50000, "AccountExternalId": "acct-001" },
    { "BKAI__External_Id__c": "opp-002", "Name": "GlobalTech – Expansion", "StageName": "Negotiation", "Amount": 150000, "AccountExternalId": "acct-002" }
  ]
}
```

### Notes
- All objects use **`BKAI__External_Id__c`** for idempotent upserts.
- Some seeds may omit `LastName`; defaults and transforms handle this.

---

## 4. Pipeline (`pipeline.json`)
```json
{
  "steps": [
    {
      "object": "Account",
      "dataFile": "./data/sales.json",
      "dataKey": "Account",
      "mode": "direct"
    },
    {
      "object": "Contact",
      "dataFile": "./data/sales.json",
      "dataKey": "Contact",
      "mode": "direct",
      "dependsOn": ["Account"]
    },
    {
      "object": "Opportunity",
      "dataFile": "./data/sales.json",
      "dataKey": "Opportunity",
      "mode": "direct",
      "dependsOn": ["Account"]
    }
  ]
}
```

### Notes
- Accounts load first.
- Contacts and Opportunities depend on Accounts.

---

## 5. Mapping Files

### 5.1 Account.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },
  "shape": {
    "fieldMap": {
      "ExternalKey": "BKAI__External_Id__c"
    },
    "defaults": {
      "Name": "Unknown Account"
    }
  },
  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Name"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },
  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```

### 5.2 Contact.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": {
      "ExternalKey": "BKAI__External_Id__c"
    },
    "defaults": {
      "LastName": "Unknown"
    },
    "removeFields": ["_debug"]
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
    { "field": "AccountId", "from": "idMaps.Account['${AccountExternalId}']", "required": true }
  ],

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "LastName", "AccountId"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest",
    "batchSize": 200
  }
}
```

### 5.3 Opportunity.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },
  "shape": {
    "fieldMap": {
      "ExternalKey": "BKAI__External_Id__c"
    }
  },
  "references": [
    { "field": "AccountId", "from": "idMaps.Account['${AccountExternalId}']", "required": true }
  ],
  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Name", "StageName", "AccountId"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },
  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```

---

## 6. Execution Flow
1. **Accounts** are upserted, populating `idMaps.Account`.
2. **Contacts** are upserted, with transforms applying defaults and resolving `AccountId`.
3. **Opportunities** are upserted, resolving `AccountId`.

---

## 7. Validation Checklist
- ✅ All seed rows contain `BKAI__External_Id__c`.
- ✅ Defaults handle missing `LastName` values.
- ✅ Transform rules remove seed-only fields post-processing.
- ✅ References ensure parent Account exists before child is inserted.
- ✅ Validation enforces required fields and uniqueness.

---

This enhanced use case demonstrates a **richer mapping definition** with **shape, transforms, references, and validations** to ensure high data quality and consistency in Sales data loading.



---

## 8. Advanced Mapping Pattern (Extended DSL, with `BKAI__External_Id__c`)
The following extends the basic mappings to a richer **declarative DSL** that supports shaping, transforms, explicit reference resolution, validation, and strategy tuning. This avoids brittle "`${BKAI__External_Id__c}`" token usage by **mapping seed aliases** to Salesforce fields via `shape.fieldMap`.

### 8.1 Contact.json (Advanced)
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": {
      "ExternalKey": "BKAI__External_Id__c"
    },
    "defaults": {
      "LastName": "Unknown"
    },
    "removeFields": ["_debug"]
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
    { "field": "AccountId", "from": "idMaps.Account['${AccountExternalId}']", "required": true }
  ],

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "LastName", "AccountId"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest",
    "batchSize": 200
  }
}
```
**Explanation**
- `identify.matchKey` – The loader keys `idMaps.Contact` by the *Salesforce* external-id field, ensuring idempotency.
- `shape.fieldMap` – Maps the seed alias `ExternalKey` → the real field `BKAI__External_Id__c`. Seeds may keep a neutral `ExternalKey` column.
- `shape.defaults` – Provides default values at shape time (before transforms) for sparse seeds.
- `shape.removeFields` – Drops helper columns (e.g., `_debug`).
- `transform.pre` – Runs before reference resolution. `coalesce` ensures `LastName` is present even if only `Name` was provided.
- `transform.post` – Cleanup after references; removes `AccountExternalId` so it doesn’t reach Salesforce.
- `references[]` – Explicit foreign key resolution using `idMaps`. The `${AccountExternalId}` token interpolates the **seed value**, not a field name.
- `validate.requiredFields` – Asserts the final payload has mandatory fields.
- `validate.uniqueBy` – Guards against duplicate seeds by external id.
- `strategy` – Upsert for idempotency; REST API with `batchSize` tuning.

---

### 8.2 Account.json (Advanced)
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": {
      "ExternalKey": "BKAI__External_Id__c"
    },
    "defaults": {
      "Industry": "Unknown",
      "Type": "Customer"
    }
  },

  "transform": {
    "pre": [
      { "op": "coalesce", "out": "Name", "from": ["Name", "CompanyName"], "default": "Unnamed Account" }
    ],
    "post": [
      { "op": "remove", "field": "ParentAccountExternalId" }
    ]
  },

  "references": [
    { "field": "ParentId", "from": "idMaps.Account && idMaps.Account['${ParentAccountExternalId}']", "required": false }
  ],

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Name"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```
**Highlights**
- Allows loading **both top-level and child Accounts** (via optional `ParentId`).
- Uses the same `ExternalKey` alias → `BKAI__External_Id__c` mapping for seed simplicity.

---

### 8.3 Opportunity.json (Advanced)
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": {
      "ExternalKey": "BKAI__External_Id__c"
    },
    "defaults": {
      "StageName": "Prospecting",
      "IsPrivate": false
    }
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
    { "field": "AccountId", "from": "idMaps.Account['${AccountExternalId}']", "required": true },
    { "field": "Primary_Contact__c", "from": "idMaps.Contact && idMaps.Contact['${PrimaryContactExternalId}']", "required": false }
  ],

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Name", "StageName", "AccountId"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```
**Notes**
- Demonstrates optional reference to a custom field `Primary_Contact__c` using a Contact external key.
- `coalesce` allows seeds to provide either `Amount` or `ExpectedRevenue`.

---

## 9. Seed & Pipeline (Advanced BKAI version)

### 9.1 Seed (`sales_bkai.json`)
```json
{
  "Account": [
    { "ExternalKey": "acct-001", "Name": "Acme Corp" },
    { "ExternalKey": "acct-002", "Name": "GlobalTech", "ParentAccountExternalId": "acct-001" }
  ],
  "Contact": [
    { "ExternalKey": "cont-001", "FirstName": "Sam", "LastName": "Lee", "Email": "sam.lee@acme.com", "AccountExternalId": "acct-001" },
    { "ExternalKey": "cont-002", "Name": "Ava Chen", "Email": "ava.chen@globaltech.com", "AccountExternalId": "acct-002", "_debug": true }
  ],
  "Opportunity": [
    { "ExternalKey": "opp-001", "Name": "Acme – Starter Deal", "StageName": "Prospecting", "Amount": 50000, "AccountExternalId": "acct-001", "PrimaryContactExternalId": "cont-001" },
    { "ExternalKey": "opp-002", "Name": "GlobalTech – Expansion", "StageName": "Negotiation", "ExpectedRevenue": 150000, "AccountExternalId": "acct-002", "PrimaryContactExternalId": "cont-002" }
  ]
}
```

### 9.2 Pipeline (`pipeline_bkai.json`)
```json
{
  "steps": [
    { "object": "Account",     "dataFile": "./data/sales_bkai.json", "dataKey": "Account",     "mode": "direct" },
    { "object": "Contact",     "dataFile": "./data/sales_bkai.json", "dataKey": "Contact",     "mode": "direct", "dependsOn": ["Account"] },
    { "object": "Opportunity", "dataFile": "./data/sales_bkai.json", "dataKey": "Opportunity", "mode": "direct", "dependsOn": ["Account", "Contact"] }
  ]
}
```
**Why `dependsOn` includes `Contact` for Opportunities?** If you use `Primary_Contact__c`, the Contact must exist before the Opportunity so that `idMaps.Contact[...]` resolves.

---

## 10. Operational Tips
- **Interpolation scope:** Only interpolate **seed values** (e.g., `${AccountExternalId}`) inside reference expressions. Do **not** interpolate *field names* like `${BKAI__External_Id__c}`.
- **Where to remove helper columns:** Prefer `transform.post` for context-specific removals (e.g., `AccountExternalId`), and `shape.removeFields` for universal removals (e.g., `_debug`).
- **Batch sizing:** Tune `strategy.batchSize` to balance API throughput vs. limits. Start with 200 for REST; consider Bulk API for very large datasets.
- **Idempotency:** Always use stable `uniqueBy` keys and `upsert` with `externalIdField` to make reruns safe.

