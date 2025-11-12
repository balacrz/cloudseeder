# Cloud Seeder – Config-Driven Salesforce Data Loader

Cloud Seeder is a Node.js–based, configuration-driven data loader for Salesforce.
It transforms seed data into Salesforce payloads using declarative mappings and a pipeline, handling object relationships, upserts, and synthetic data generation—without writing custom code for every load.

## Who is it for?
Salesforce architects, admins, and developers who need repeatable, resilient, and hierarchy-aware data loading for demos, sandboxes, and test environments.

## What Cloud Seeder Delivers
- **Config-Driven Loads:** No ad-hoc scripts—define mappings and a pipeline once, reuse everywhere.
- **Hierarchy Handling:** Load parent→child records (e.g., Account → Contact → Opportunity) with reference resolution.
- **True Upsert:** Identify by External Id or composite keys; avoid duplicates across runs.
- **Synthetic Data:** Optional generators to fabricate realistic hierarchies for demos and QA.
- **Batch-Friendly:** Large loads with per-step logging and failure visibility.
- **Dry Runs & Tracing:** Validate before writing; verbose logs when you need them.


## Core Concepts
- **Seed Data:** Simple JSON objects representing the records you want (with external keys).
- **Mappings:** JSON rules describing how to shape seeds into SObject payloads, which fields identify uniqueness, and which references to resolve.
- **Pipeline:** Ordered steps telling Cloud Seeder which object to load, in which mode (insert/upsert), and with which mapping.
- **Generators (Optional):** Functions that expand or reshape seeds (e.g., create child Accounts from a parent list).
- **idMaps:** A cross-run dictionary of external keys → Salesforce Ids used for reference resolution and re-runs.

## Problem statement
Manual seeding is brittle: hard-coded IDs, fragile relationship chains, no easy preview, and poor repeatability across environments.

## Solution
- Declarative, step-based loading
- Reference resolution via key→Id maps
- Pre/Post transforms (assign, copy, rename, remove, coalesce, concat)
- Validation (required fields, uniqueness)
- Batching & strategy control (insert/upsert)
- **DRY_RUN** mode for safe previews

## Execution steps
1. **Install**
   ```bash
   npm install

2. **Configure Org**
Setup .env file
    ```
    export SF_LOGIN_URL="https://login.salesforce.com"
    export SF_USERNAME="you@example.com"
    export SF_PASSWORD="yourPassword +yourSecurityToken"
    ```

3. **Load Data**
   ```bash
   npm start

## Quick Start Videos

- [Sales Cloud Demo](https://youtu.be/Whx_BmgYo0Y "Demo")
- [High Level Project Structure](https://youtu.be/T8UvFeC5emg "High Level")

## More details

For deeper documentation (Sample use cases, configuration guides, mapping & pipeline references, and troubleshooting), see the **`docs/`** folder in this repository.

## License

The license for wit-go can be found in LICENSE file in the root directory of
this source tree.
