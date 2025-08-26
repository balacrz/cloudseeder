# Field Service Use Case – Territories, Resources, Work Orders & Appointments

## 1) Introduction
This guide shows how to configure **Salesforce Field Service** data loads using a **purely declarative** approach (no code edits) with seeds, pipelines, and mappings.

We’ll model a minimal but realistic setup:
- **Operating/Business Hours** (optional but recommended)
- **Service Territory** (optionally tied to Operating Hours)
- **Service Resource** (a mobile worker/technician)
- **Service Territory Member** (junction: Resource ↔ Territory)
- **Work Type** (template for work)
- **Work Order** (associated to an Account, and optionally a Work Type/Territory)
- **Service Appointment** (child of Work Order; assigned to Territory/Resource)

All identities use a consistent **external id** field `BKAI__External_Id__c` mapped from a neutral seed alias `ExternalKey`.

---

## 2) Seed Data (`field_service.json`)
```json
{
  "OperatingHours": [
    { "ExternalKey": "hrs-chi", "Name": "CHI Hours", "TimeZoneSidKey": "America/Chicago", "IsDefault": false }
  ],

  "ServiceTerritory": [
    { "ExternalKey": "ter-chi", "Name": "Chicago Territory", "OperatingHoursExternalId": "hrs-chi" }
  ],

  "ServiceResource": [
    { "ExternalKey": "res-anna", "Name": "Anna Rivera", "ResourceType": "Technician", "MobilePhone": "+1-312-555-1111" }
  ],

  "ServiceTerritoryMember": [
    { "ExternalKey": "stm-anna-chi", "ServiceResourceExternalId": "res-anna", "ServiceTerritoryExternalId": "ter-chi", "IsActive": true }
  ],

  "WorkType": [
    { "ExternalKey": "wt-install", "Name": "Equipment Install", "EstimatedDuration": 120 }
  ],

  "Account": [
    { "ExternalKey": "acct-001", "Name": "Acme Clinic – Loop" }
  ],

  "WorkOrder": [
    { "ExternalKey": "wo-0001", "Subject": "Install MRI Base", "AccountExternalId": "acct-001", "ServiceTerritoryExternalId": "ter-chi", "WorkTypeExternalId": "wt-install", "Priority": 3 }
  ],

  "ServiceAppointment": [
    { "ExternalKey": "sa-0001", "ParentWorkOrderExternalId": "wo-0001", "ServiceTerritoryExternalId": "ter-chi", "OwnerResourceExternalId": "res-anna", "EarliestStartTime": "2025-09-01T09:00:00.000Z", "DueDate": "2025-09-01T11:00:00.000Z", "Status": "Scheduled" }
  ]
}
```

**Notes**
- `ExternalKey` is the neutral seed identity; the mappings will write it into `BKAI__External_Id__c`.
- `ServiceAppointment` references both Territory and a specific Resource via their externals.
- `WorkOrder` references Account, Work Type, and Territory.

---

## 3) Pipeline (`pipeline_field_service.json`)
```json
{
  "steps": [
    { "object": "OperatingHours",        "dataFile": "./data/field_service.json", "dataKey": "OperatingHours",        "mode": "direct" },
    { "object": "ServiceTerritory",      "dataFile": "./data/field_service.json", "dataKey": "ServiceTerritory",      "mode": "direct", "dependsOn": ["OperatingHours"] },
    { "object": "ServiceResource",       "dataFile": "./data/field_service.json", "dataKey": "ServiceResource",       "mode": "direct" },
    { "object": "ServiceTerritoryMember", "dataFile": "./data/field_service.json", "dataKey": "ServiceTerritoryMember", "mode": "direct", "dependsOn": ["ServiceTerritory", "ServiceResource"] },
    { "object": "WorkType",              "dataFile": "./data/field_service.json", "dataKey": "WorkType",              "mode": "direct" },
    { "object": "Account",               "dataFile": "./data/field_service.json", "dataKey": "Account",               "mode": "direct" },
    { "object": "WorkOrder",             "dataFile": "./data/field_service.json", "dataKey": "WorkOrder",             "mode": "direct", "dependsOn": ["Account", "ServiceTerritory", "WorkType"] },
    { "object": "ServiceAppointment",    "dataFile": "./data/field_service.json", "dataKey": "ServiceAppointment",    "mode": "direct", "dependsOn": ["WorkOrder", "ServiceTerritory", "ServiceResource"] }
  ]
}
```

**Why this order?**
- Territories may depend on Operating Hours.
- Territory Members join existing Resources to existing Territories.
- Work Orders depend on Account/Territory/Work Type.
- Service Appointments depend on Work Orders and (optionally) Resource/Territory.

---

## 4) Mapping Files (Advanced DSL)
All mappings below use the same declarative shape/transform/reference/validate/strategy pattern for consistency.

### 4.1 OperatingHours.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": { "ExternalKey": "BKAI__External_Id__c" },
    "defaults": { "IsDefault": false }
  },

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Name", "TimeZoneSidKey"],
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

### 4.2 ServiceTerritory.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": { "ExternalKey": "BKAI__External_Id__c" }
  },

  "references": [
    { "field": "OperatingHoursId", "from": "idMaps.OperatingHours && idMaps.OperatingHours['${OperatingHoursExternalId}']", "required": false }
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

### 4.3 ServiceResource.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": { "ExternalKey": "BKAI__External_Id__c" },
    "defaults": { "IsActive": true }
  },

  "transform": {
    "pre": [
      { "op": "coalesce", "out": "ResourceType", "from": ["ResourceType", "Type"], "default": "Technician" }
    ]
  },

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Name", "ResourceType"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```

### 4.4 ServiceTerritoryMember.json (Junction)
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": { "fieldMap": { "ExternalKey": "BKAI__External_Id__c" } },

  "references": [
    { "field": "ServiceResourceId",  "from": "idMaps.ServiceResource['${ServiceResourceExternalId}']",  "required": true },
    { "field": "ServiceTerritoryId", "from": "idMaps.ServiceTerritory['${ServiceTerritoryExternalId}']", "required": true }
  ],

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "ServiceResourceId", "ServiceTerritoryId"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```

### 4.5 WorkType.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },
  "shape":    { "fieldMap": { "ExternalKey": "BKAI__External_Id__c" } },

  "transform": { "pre": [ { "op": "coalesce", "out": "EstimatedDuration", "from": ["EstimatedDuration", "DefaultDuration"], "default": 60 } ] },

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Name", "EstimatedDuration"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```

### 4.6 Account.json (minimal for WO reference)
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },
  "shape":    { "fieldMap": { "ExternalKey": "BKAI__External_Id__c" } },
  "validate": { "requiredFields": ["BKAI__External_Id__c", "Name"], "uniqueBy": ["BKAI__External_Id__c"] },
  "strategy": { "operation": "upsert", "externalIdField": "BKAI__External_Id__c", "api": "rest" }
}
```

### 4.7 WorkOrder.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": { "ExternalKey": "BKAI__External_Id__c" },
    "defaults": { "Status": "New" }
  },

  "references": [
    { "field": "AccountId",         "from": "idMaps.Account['${AccountExternalId}']",           "required": true },
    { "field": "ServiceTerritoryId", "from": "idMaps.ServiceTerritory['${ServiceTerritoryExternalId}']", "required": false },
    { "field": "WorkTypeId",         "from": "idMaps.WorkType && idMaps.WorkType['${WorkTypeExternalId}']", "required": false }
  ],

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "Subject", "AccountId"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```

### 4.8 ServiceAppointment.json
```json
{
  "identify": { "matchKey": "BKAI__External_Id__c" },

  "shape": {
    "fieldMap": { "ExternalKey": "BKAI__External_Id__c" },
    "defaults": { "Status": "None" }
  },

  "transform": {
    "pre": [
      { "op": "coalesce", "out": "Status", "from": ["Status"], "default": "Scheduled" }
    ],
    "post": [
      { "op": "remove", "field": "ParentWorkOrderExternalId" },
      { "op": "remove", "field": "ServiceTerritoryExternalId" },
      { "op": "remove", "field": "OwnerResourceExternalId" }
    ]
  },

  "references": [
    { "field": "ParentRecordId",    "from": "idMaps.WorkOrder['${ParentWorkOrderExternalId}']",    "required": true },
    { "field": "ServiceTerritoryId", "from": "idMaps.ServiceTerritory['${ServiceTerritoryExternalId}']", "required": false },
    { "field": "AssignedResourceId", "from": "idMaps.ServiceResource && idMaps.ServiceResource['${OwnerResourceExternalId}']", "required": false }
  ],

  "validate": {
    "requiredFields": ["BKAI__External_Id__c", "ParentRecordId", "EarliestStartTime", "DueDate", "Status"],
    "uniqueBy": ["BKAI__External_Id__c"]
  },

  "strategy": {
    "operation": "upsert",
    "externalIdField": "BKAI__External_Id__c",
    "api": "rest"
  }
}
```

> **Field names may vary by org** (e.g., `ParentRecordId` vs. `WorkOrderId`, `AssignedResourceId` vs. `ServiceResourceId`). Adjust to your SObject schema.

---

## 5) Execution Flow
1. **OperatingHours** → populates `idMaps.OperatingHours`.
2. **ServiceTerritory** → resolves `OperatingHoursId` (optional).
3. **ServiceResource** → creates technicians.
4. **ServiceTerritoryMember** → joins technicians to territories.
5. **WorkType** → templating & duration defaults.
6. **Account** → parent for Work Orders.
7. **WorkOrder** → resolves Account/Territory/WorkType.
8. **ServiceAppointment** → resolves WorkOrder/Territory/Resource.

---

## 6) Validation Checklist
- ✅ Every seed row has a stable `ExternalKey`.
- ✅ All mappings write to `BKAI__External_Id__c` via `shape.fieldMap`.
- ✅ References only appear **after** parent objects in the pipeline.
- ✅ Helper columns removed in `transform.post` to keep payloads clean.
- ✅ `upsert` used where external ids exist; junctions also upserted by external ids for idempotency.
- ✅ Time fields (`EarliestStartTime`, `DueDate`) use ISO-8601 and correct timezone.

---

## 7) Tips & Variations
- Use **Bulk API** if you have tens of thousands of records; keep the same mapping spec and change `strategy.api`/batch sizes.
- Add **Skills/ResourceSkill** similarly:
  - `Skill` upsert by external id; `ResourceSkill` references `ServiceResource` + `Skill` + level.
- If using **Scheduling Policies**, seed & map `SchedulingPolicy` and reference it on `ServiceAppointment`.

This end-to-end Field Service configuration demonstrates how to seed, map, and orchestrate a realistic technician scheduling setup using a clean, repeatable, declarative approach.

