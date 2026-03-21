# CloudSeeder

CloudSeeder is a config-driven data seeding tool for Salesforce. It lets you define exactly what data to load — and how — using JSON configuration files, without writing any code. Whether you're preparing a demo org, resetting a sandbox, or seeding test data in CI, CloudSeeder handles the heavy lifting: dependency ordering, field mapping, reference resolution, and idempotent upserts.

---

## Why CloudSeeder

Populating Salesforce with realistic, relational data is repetitive and error-prone. Every team ends up with scripts that are brittle, order-sensitive, and hard to reuse. CloudSeeder replaces that with a declarative pipeline that:

- **Loads data in the right order** — you declare which objects depend on which, and CloudSeeder figures out the execution sequence automatically.
- **Resolves relationships for you** — once Accounts are loaded, Contact and Opportunity steps automatically receive the correct Salesforce IDs without any manual ID management.
- **Is safe to re-run** — upsert operations with external ID fields mean running the same pipeline twice updates existing records rather than creating duplicates.
- **Validates before it commits** — required fields, uniqueness, and field-level compatibility with the org's schema are all checked before any data is written.
- **Works across environments** — environment overlays let you point the same pipeline at dev, staging, or production orgs with different settings.

---

## Who It's For

**Demo Engineers / Solutions Engineers** — populate a Salesforce demo org with realistic sample data before a customer presentation. Define seed files once, reuse them across orgs. Re-run anytime to restore the org to a known state.

**Salesforce Developers / Admins** — seed a development or scratch org with data that matches your production schema. CloudSeeder can auto-create required external ID fields and grant the necessary field-level access, so you don't have to set up fields manually before the first run.

**QA / Test Automation Engineers** — integrate CloudSeeder into a CI pipeline to reset a scratch org to a known data state before running automated tests. Use dry run mode to validate pipeline configuration without making API calls.

---

## Key Capabilities

- **Declarative pipeline** — define steps in a JSON file; no custom code required for standard load patterns
- **Field mapping and transforms** — rename fields, set defaults, run pre/post transform operations (assign, copy, rename, remove, coalesce, concat)
- **Parent-child reference resolution** — automatically populate Salesforce lookup fields using IDs returned from earlier steps
- **Three API strategies** — REST, Composite, and Bulk API 2.0, selectable per object step
- **Idempotent upserts** — external ID fields ensure re-runs update, not duplicate
- **Record filtering** — declarative filter predicates to subset records before loading (exists, equals, in, regex, numeric comparisons, AND/OR/NOT)
- **Dry run mode** — run the full transform pipeline and validate payloads without writing to Salesforce
- **Metadata validation** — field existence and writability are checked against the live org before committing; unknown fields are pruned automatically
- **Auto external ID creation** — optionally create missing external ID fields and grant field-level security via Permission Sets
- **Environment overlays** — per-environment config overrides for constants, pipeline settings, and mapping files
- **Structured logging** — timestamped console output plus a per-run log file with a JSON run report

---

## How It Works

Each pipeline step targets one Salesforce object. Steps declare their dependencies, and CloudSeeder resolves the execution order. For each step, records are loaded from a seed file, filtered, shaped, transformed, and committed to Salesforce. The Salesforce IDs returned from each step are made available to all downstream steps for reference resolution.

```
pipeline.json
     │
     ▼
Topological sort (by dependsOn)
     │
     ▼  for each step:
  Load seed records
  Apply filter
  Shape: rename fields, set defaults, remove helper columns
  Pre-transforms
  Resolve parent references → Salesforce IDs from prior steps
  Post-transforms
  Validate required fields + uniqueness
  Prune fields not in org schema
  Commit to Salesforce (REST / Composite / Bulk)
  Store ID map for downstream steps
```

---

## Use Cases

End-to-end walkthroughs with seed data, pipeline config, mapping files, and execution flow:

| Use Case | Doc | Objects |
|---|---|---|
| Sales pipeline | [docs/usecases/sales.md](docs/usecases/sales.md) | Account, Contact, Opportunity |
| Product hierarchy | [docs/usecases/producthierarchy.md](docs/usecases/producthierarchy.md) | Product2 (3-level), Pricebook2, PricebookEntry |

---

## Documentation

| Document | Description |
|---|---|
| [docs/setup.md](docs/setup.md) | Installation, credentials, and how to run |
| [docs/README.md](docs/README.md) | Full configuration and API reference |
| [docs/usecases/sales.md](docs/usecases/sales.md) | Sales Cloud walkthrough |
| [docs/usecases/producthierarchy.md](docs/usecases/producthierarchy.md) | Product hierarchy walkthrough |

---

## File Structure

```
cloudseeder/
├── .env                          # Environment variables (not committed)
├── package.json                  # npm config; "type": "module" (ESM)
├── scripts/
│   └── runLoad.js                # CLI entry point and pipeline orchestrator
├── lib/
│   ├── loader.js                 # Per-step transform + commit pipeline
│   ├── filters.js                # Declarative record filter engine
│   ├── config/
│   │   ├── index.js              # Re-exports all config loaders
│   │   ├── pipeline.js           # Load pipeline.json (+ env overlay)
│   │   ├── constants.js          # Load constants.json (+ env overlay)
│   │   ├── step-config.js        # Load + merge object mapping configs (cached)
│   │   ├── env.js                # Environment variable helpers
│   │   └── utils.js              # JSON5 reader, deepMerge
│   ├── pipeline/
│   │   ├── orchestrator.js       # Pipeline orchestration logic
│   │   ├── dataloader.js         # Data loading and batching
│   │   ├── generators.js         # Built-in data generators
│   │   └── toposort.js           # Topological sort for step ordering
│   ├── salesforce/
│   │   ├── auth.js               # Salesforce login via jsforce
│   │   ├── commit.js             # REST / Composite / Bulk commit strategies
│   │   ├── metadata.js           # Metadata snapshot, pruning, validation
│   │   └── permset.js            # Permission Set + FLS management
│   ├── transform/
│   │   ├── index.js              # Re-exports transform functions
│   │   ├── shape.js              # shapeRecord logic
│   │   ├── transforms.js         # applyTransforms logic
│   │   ├── constants.js          # resolveConstantsDeep logic
│   │   └── ref-solver.js         # Foreign key reference resolution
│   ├── utils/
│   │   ├── logger.js             # Leveled console logger
│   │   ├── duallogger.js         # Console + file dual logger
│   │   ├── runlog.js             # Per-run file logger
│   │   └── runcontext.js         # Runtime singleton: org ID
│   └── validators/
│       └── validatematchkeys.js  # Match key validation
├── services/
│   └── generators.js             # Custom data generators
├── config/
│   ├── pipeline.json             # Pipeline definition (edit this)
│   ├── constants.json            # Shared constants
│   └── sales/
│       ├── data/
│       │   └── seed.json         # Sample seed data (Account, Contact, Opportunity)
│       └── mappings/
│           ├── Account.json      # Account mapping
│           ├── Contact.json      # Contact mapping
│           └── Opportunity.json  # Opportunity mapping
├── docs/
│   ├── README.md                 # Full config & API reference guide
│   ├── setup.md                  # Installation and execution guide
│   └── usecases/
│       ├── sales.md              # Account, Contact, Opportunity walkthrough
│       └── producthierarchy.md   # 3-level Product2 + Pricebook walkthrough
├── requirements/
│   ├── requirements.md           # Functional and non-functional requirements
│   ├── implementation.md         # Architecture and module reference
│   ├── code.md                   # Code-level reference
│   └── sample.md                 # Sample configuration reference
├── meta-data/                    # (generated) Object describe cache
│   └── <ORG_ID>/
│       └── <Object>.json
└── logs/                         # (generated) Per-run log files
    └── run-YYYYMMDD_HHMMSSZ.log
```

---

## License

Apache 2.0. See [LICENSE](LICENSE) for details.
