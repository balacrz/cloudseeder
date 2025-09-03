# CloudSeeder – Simple Guide

CloudSeeder is a small app that helps you **load sample data into Salesforce** in a safe, repeatable way.  
You don’t have to be technical: you run a few commands, and it takes care of the rest.

---

## What it does (in plain English)

- **Gets your data ready** so Salesforce accepts it.
- **Keeps relationships** between records (e.g., “this item belongs to that one”).
- **Avoids duplicates** by recognizing records it has already created.
- Lets you do a **practice run** (no changes) before doing the real thing.

---

## When to use it

- Spinning up a **new sandbox** with realistic data.
- Refreshing data for a **demo** or **testing**.
- Loading data again without creating duplicates.

---

## What you’ll need

- A Salesforce login you’re allowed to use.
- Node.js installed (your IT team can help if unsure).
- This project downloaded to your computer.

---

## Highlights: Seed Data, Mapping, Pipeline, Configuration

### Seed data (your source records)
- **What it is:** The rows CloudSeeder reads to create/update records.
- **Must have:** A stable **match key** per row so re-runs don’t create duplicates.
- **Should include:** Any **helper keys** needed to link related rows (e.g., parent/owner keys).
- **Keep it clean:** Consistent formats, no unnecessary fields, avoid sensitive data.
- **Tip:** Validate inputs early (empty values, typos, unexpected enums).

---

### Mapping (how a row becomes a ready-to-send record)
- **Identity:** Define the **match key** (and external-id field if using upsert).
- **Fields:** Decide which source values become target fields (fixed values, copies, or simple `${tokens}`).
- **References:** Declare how lookups are resolved using prior step results  
  – use a **key** (or a template) and, when needed, specify the target type.
- **Transforms:** Optional **pre/post** steps to assign, copy, rename, remove, coalesce, or concat fields.
- **Validation:** Mark fields as **required** and add **uniqueness** guards where needed.
- **Strategy:** Choose **insert / upsert / update**, API transport, and batch size.

---

### Pipeline (the order steps run)
- **Steps:** Each step points to seed data and the mapping to apply.
- **Ordering:** Load **prerequisites first** so later steps can resolve references correctly.
- **Dependencies:** Make relationships explicit so the run engine can sequence steps.
- **Filtering:** Only pass rows each step can actually process (e.g., rows that have required keys).
- **Dry run:** Preview shaped payloads and relationship resolution **without writing**.
- **Outcomes:** Each completed step adds to **id maps** (key→Id) used by following steps.

---

### Configuration (run-time knobs & behavior)
- **Environment:** Select target environment for the run (e.g., dev/qa/prod overlays).
- **Constants:** Reusable values available via `${...}` in mappings and transforms.
- **Batching & API:** Control batch size and transport to balance speed and limits.
- **Logging:** Choose verbosity; enable detailed reference logs for troubleshooting.
- **Error handling:** Decide whether to fail fast, skip missing pieces, or substitute nulls.
- **Safety:** Prefer **upsert** for idempotency; start with **dry run** before real writes.

---

### Sample(Use Cases)
How to try a sample
Samples are designed so you can explore how data, mappings, and pipeline configuration work together—then reuse the pattern for your own data.

Pick a folder under Usecases/