# Product Hierarchy Use Case – 3‑Level Catalog with Optional Pricing

## 1) Introduction
This guide shows how to model a **3‑level product hierarchy** (Category → Subcategory → Item) using a **purely declarative** configuration: seeds, pipeline, and mappings. We also include optional **Price Book** and **Pricebook Entry** setup so that final-level Items are sellable in Salesforce.

> **Schema note:** Standard `Product2` does not include a parent pointer. This guide assumes a custom lookup field on `Product2`, e.g., **`Parent_Product__c`** (Lookup → Product2). Rename the field in the mappings if your org uses a different API name.

---

## 2) Seed Data (`products_hierarchy.json`)
```json
{
  "Product2": [
    { "ExternalKey": "PROD-MED", "Name": "Medical Equipment", "IsActive": true },
    { "ExternalKey": "PROD-MED-DIAG", "Name": "Diagnostic Devices", "ParentExternalId": "PROD-MED", "Level": 2, "IsActive": true },
    { "ExternalKey": "PROD-MED-DIAG-MRI", "Name": "MRI Scanner", "ParentExternalId": "PROD-MED-DIAG", "Level": 3, "IsActive": true },

    { "ExternalKey": "PROD-MED-THER", "Name": "Therapeutic Devices", "ParentExternalId": "PROD-MED", "Level": 2, "IsActive": true },
    { "ExternalKey": "PROD-MED-THER-PUMP", "Name": "Infusion Pump", "ParentExternalId": "PROD-MED-THER", "Level": 3, "IsActive": true }
  ],

  "Pricebook2": [
    { "ExternalKey": "PB-STANDARD", "Name": "Standard Price Book", "IsActive": true, "IsStandard": true },
    { "ExternalKey": "PB-LIST",     "Name": "List Price Book",     "IsActive": true, "IsStandard": false }
  ],

  "PricebookEntry": [
    { "ExternalKey": "PBE-MRI-STD",  "ProductExternalId": "PROD-MED-DIAG-MRI",   "PricebookExternalId": "PB-STANDARD", "UnitPrice": 950000, "IsActive": true },
    { "ExternalKey": "PBE-MRI-LIST", "ProductExternalId": "PROD-MED-DIAG-MRI",   "PricebookExternalId": "PB-LIST",     "UnitPrice": 980000, "IsActive": true },
    { "ExternalKey": "PBE-PUMP-STD", "ProductExternalId": "PROD-MED-THER-PUMP",  "PricebookExternalId": "PB-STANDARD", "UnitPrice": 7200,   "IsActive": true }
  ]
}
```

**Highlights**
- `ExternalKey` is the neutral identity used in seeds.
- Level 1 (root) omits `ParentExternalId`.
- Only **level‑3 (Item)** products get pricebook entries.
- A **standard** and a **custom** price book are demonstrated.

---

## 3) Pipeline (`pipeline_products_hierarchy.json`)
```json
{
  "steps": [
    {
      "object": "Product2",
      "dataFile": "./data/products_hierarchy.json",
      "dataKey": "Product2",
      "mode": "direct",
      "filter": { "missing": "ParentExternalId" }
    },
    {
      "object": "Product2",
      "dataFile": "./data/products_hierarchy.json",
      "dataKey": "Product2",
      "mode": "direct",
      "dependsOn": ["Product2"],
      "filter": { "expr": "seed.Level === 2" }
    },
    {
      "object": "Product2",
      "dataFile": "./data/products_hierarchy.json",
      "dataKey": "Product2",
      "mode": "direct",
      "dependsOn": ["Product2"],
      "filter": { "expr": "seed.Level === 3" }
    },

    { "object": "Pricebook2",    "dataFile": "./data/products_hierarchy.json", "dataKey": "Pricebook2",    "mode": "direct" },
    { "object": "PricebookEntry", "dataFile": "./data/products_hierarchy.json", "dataKey": "PricebookEntry", "mode": "direct", "dependsOn": ["Product2", "Pricebook2"] }
  ]
}
```

**Why this order?**
- Root categories (no parent) first → ensures parents exist for L2.
- Level 2 next → ensures parents exist for L3.
- Level 3 next → all leaf items now exist.
- Price books before pricebook entries.

---

## 4) Mapping Files (Advanced DSL)
All mappings use the declarative pattern: **shape → transform → references → validate → strategy**. The external id we write to Salesforce is `BKAI__External_Id__c` via `shape.fieldMap`.

### 4.1 Product2.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": { "ExternalKey": "BKAI__External_Id__c" },
    "defaults": { "IsActive": true }
  },

  "transform": {
    "pre": [
      { "op": "coalesce", "out": "IsActive", "from": ["IsActive"], "default": true }
    ],
    "post": [
      { "op": "remove", "field": "ParentExternalId" },
      { "op": "remove", "field": "Level" }
    ]
  },

  "references": [
    { "field": "Parent_Product__c", "from": "idMaps.Product2 && idMaps.Product2['${ParentExternalId}']", "required": false }
  ],

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Name"],
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

### 4.2 Pricebook2.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },
  "shape":    { "fieldMap": { "ExternalKey": "BKAI__External_Id__c" } },

  "transform": {
    "pre": [
      { "op": "coalesce", "out": "IsActive",   "from": ["IsActive"],   "default": true },
      { "op": "coalesce", "out": "IsStandard", "from": ["IsStandard"], "default": false }
    ]
  },

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Name", "IsActive"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```

### 4.3 PricebookEntry.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": { "fieldMap": { "ExternalKey": "BKAI__External_Id__c" } },

  "references": [
    { "field": "Product2Id",  "from": "idMaps.Product2['${ProductExternalId}']",   "required": true },
    { "field": "Pricebook2Id", "from": "idMaps.Pricebook2['${PricebookExternalId}']", "required": true }
  ],

  "transform": {
    "pre": [
      { "op": "coalesce", "out": "UseStandardPrice", "from": ["UseStandardPrice"], "default": false }
    ],
    "post": [
      { "op": "remove", "field": "ProductExternalId" },
      { "op": "remove", "field": "PricebookExternalId" }
    ]
  },

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Product2Id", "Pricebook2Id", "UnitPrice"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```

> **Standard Price Book Gotcha:** Salesforce allows only one **Standard** price book per org. If your org already has one, either (a) skip seeding a new standard price book and only create entries for the existing one, or (b) treat your seeded "Standard" as a non‑standard price book and keep `IsStandard=false`.

---

## 5) Execution Flow
1. **Product2 (roots)** – create Level‑1 categories.
2. **Product2 (L2)** – reference parents from Step 1.
3. **Product2 (L3)** – reference parents from Step 2; these are sellable items.
4. **Pricebook2** – upsert standard/custom price books.
5. **PricebookEntry** – attach L3 items to price books with prices.

---

## 6) Validation Checklist
- ✅ Every seed row has a stable `ExternalKey`.
- ✅ `Product2` mappings write `ExternalKey` → `BKAI__External_Id__c`.
- ✅ Parent lookups (`Parent_Product__c`) resolve only after parents are loaded.
- ✅ Pricebook Entries reference existing Product2 and Pricebook2 ids.
- ✅ L3 items have `UnitPrice` and (optionally) `UseStandardPrice` rules.

---

## 7) Variations & Tips
- **Flags instead of Level**: If you prefer flags, change pipeline filters to `{ "exists": "FirstChild" }` / `{ "exists": "SecondChild" }` and carry `FirstChild`/`SecondChild` in seeds.
- **Attributes**: Add a custom object `Product_Attribute__c` and a junction `Product_Attribute_Value__c` to model specs like magnet strength, bore size, etc.—same reference pattern applies.
- **Localization**: For multilingual catalogs, seed `Product2` translations in a separate step or store display labels in a related custom object.
- **Bulk loads**: For >100k products/entries, flip `strategy.api` to `bulk` and adjust batch sizes.

This end‑to‑end configuration demonstrates a robust, repeatable way to build and price a hierarchical product catalog using only configuration.

