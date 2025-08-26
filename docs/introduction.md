# Mapping & Pipeline Reference – Node.js Salesforce Data Loader

## 1. Introduction
The **Node.js Salesforce Data Loader** is a configuration-driven framework that enables developers and administrators to manage complex Salesforce data loading scenarios without custom code. Instead of hardcoding transformations and relationships, the loader uses **seed data**, **mapping files**, and **pipelines** to:
- Transform structured seed records into Salesforce SObject payloads.
- Maintain consistent and idempotent record identities across multiple runs.
- Handle hierarchical dependencies between objects automatically through sequencing and `idMaps` resolution.

This documentation serves as a **foundational reference** for understanding mapping generation and pipeline construction. It focuses on **detailed concepts and explanations** (without diving into specific use cases). Separate documents will be maintained for **Sales**, **Field Service**, and **Product Hierarchy** scenarios.

---

## 2. Core Concepts

### 2.1 Seed Data
Seed data is the raw input (JSON/CSV) that contains the initial values used to create Salesforce records. Seeds typically include business identifiers (e.g., External Ids) and descriptive fields (e.g., Name, Email).

### 2.2 Mapping File
Mapping files define how a **single seed row** is transformed into a Salesforce API payload. They specify record identity, writing strategy, and how fields are populated.

### 2.3 Pipeline
Pipelines orchestrate the sequence of mapping steps. They specify which objects to load, where their seed data resides, and in what order steps should run to ensure dependencies are met.

### 2.4 idMaps
An in-memory dictionary used to resolve relationships between objects. It maps external keys from seed data to Salesforce record IDs once records are inserted or upserted.

---

## 3. Mapping File Specification

### 3.1 Identity (`identify`)
Defines how records are uniquely identified.
- **`matchKey`**: A seed field or composite key used to track identity across pipeline runs.
- Populates `idMaps[Object][matchKey] = SalesforceId`.

### 3.2 Strategy (`strategy`)
Defines how records are written.
- **`operation`**: One of `insert`, `upsert`, or `update`.
- **`externalIdField`**: Required when using `upsert`.
- **`api`**: Transport mechanism, typically `rest` for smaller loads and `bulk` for large volumes.

### 3.3 Fields (`fields`)
Describes how seed values map to Salesforce fields.
- **Literal values**: Static assignments.
- **Template strings**: Interpolation from seed fields (e.g., `${Name}`).
- **Expression objects**: JavaScript expressions evaluated post-interpolation with access to `seed`, `idMaps`, and helper utilities.

### 3.4 Evaluation Order
1. Load seed row.
2. Interpolate `${}` tokens.
3. Evaluate `expr` objects.
4. Build final Salesforce payload.
5. Execute operation.
6. Update `idMaps` with results.

### 3.5 Null/Undefined Handling
- Missing values → `undefined` (field omitted).
- Explicit `null` → clears field if API allows.
- Undefined fields are not included in payload.

### 3.6 idMaps Lifecycle
- **Shape**: `{ Account: { "acct-001": "001xx..." } }`.
- **Population**: After each successful insert/upsert.
- **Consumption**: Used in expressions to resolve foreign keys for later objects.

### 3.7 Error Handling
- **Missing references**: Loader may throw error or skip based on configuration.
- **Duplicate external ids**: Managed based on strategy (`upsert` vs `insert`).
- **Validation errors**: Surfaced from Salesforce API response.

---

## 4. Advanced Patterns
- **Composite keys**: Used for junction objects without natural external Ids.
- **Conditional defaults**: Populate fallback values if seed fields are missing.
- **Concatenation/interpolation**: Combine multiple seed fields into one Salesforce field.
- **Guarded lookups**: Safe navigation for references to avoid runtime errors.

---

## 5. Validation Checklist
- ✅ `matchKey` fields exist in all seeds.
- ✅ Parent objects are loaded before children.
- ✅ External Ids are consistent and case-sensitive.
- ✅ Undefined fields are omitted (not sent as null unless intentional).
- ✅ `idMaps` is merged, not overwritten, across steps.
- ✅ `strategy` uses `upsert` where possible for idempotency.

---

## 6. Quick Reference Cheat Sheet
- **Identity** → `identify.matchKey`.
- **Strategy** → `insert`, `upsert`, or `update`.
- **API** → `rest` or `bulk`.
- **Field values** → literals | `${tokens}` | `{ expr }`.
- **References** → `idMaps.ObjectName[externalKey]`.
- **Order of operations** → parent → child → junction → supporting records.

---

This **core documentation** explains the principles of mapping and pipeline generation. 

👉 Separate documents will provide **hands-on examples** for:
- **Sales (Account–Contact–Opportunity)**
- **Field Service (Territories, Resources, Work Orders)**
- **Product Hierarchy (multi-level parent–child products)**

