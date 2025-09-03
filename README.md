# CloudSeeder

Config-driven Salesforce data seeding & upsert pipeline that turns plain data into ready-to-load records, resolves relationships automatically, and commits in batches—safely previewable with a dry-run.

## Introduction
CloudSeeder streamlines populating a target org with realistic, interconnected data. It separates what to load from how to shape and relate it, applies reusable transforms, and resolves references without hand-crafted IDs.

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
    ```bash
export SF_LOGIN_URL="https://login.salesforce.com"
export SF_USERNAME="you@example.com"
export SF_PASSWORD="yourPassword +yourSecurityToken"

3. **Load Data**
   ```bash
   npm start