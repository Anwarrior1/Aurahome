# AURA home — ERP

Offline desktop ERP for the AURA home furniture factory. One Windows PC,
fully offline, Arabic-only RTL interface, Libyan Dinar.

- **Step 1** — 114 confirmed business rules (BR-1 … BR-114)
- **Step 2** — desktop architecture (Electron + Node + SQLite), AD-1 … AD-6
- **Step 3** — project structure and layer boundaries
- **Step 4** — the full ERP implementation (this repository)

## Getting started

```bash
npm install        # also rebuilds better-sqlite3 for Electron's ABI (postinstall)
npm run dev        # launch the app
npm run typecheck  # strict tsc for both the node and web halves
npm run lint
npm test           # vitest — unit + integration against a real SQLite database
npm run build      # production bundles into out/
```

`npm install` needs internet once, on the developer's machine. The shipped
application itself never touches the network.

**First run** shows a setup screen that creates the full-access administrator
account (BR-55), a cash account, and starter expense categories.

## Database

```bash
npm run db:generate   # regenerate drizzle/migrations from src/main/db/schema
npm run db:studio
```

Migrations are committed and applied automatically at startup by
`src/main/migrations/migration-runner.ts`, which takes an automatic backup
first whenever the database already holds business data.

## Reset development/test business data

Close the ERP, then select the database explicitly:

```bash
npm run reset:business-data -- --database "/absolute/path/to/erp.db" --confirm RESET-DEVELOPMENT-BUSINESS-DATA --dry-run
npm run reset:business-data -- --database "/absolute/path/to/erp.db" --confirm RESET-DEVELOPMENT-BUSINESS-DATA --report "/absolute/path/to/reset-counts.json"
```

The command refuses production mode, packaged execution, missing admin access
and unclassified schema tables. It creates and verifies a backup before an
atomic reset with foreign keys enabled. Business/master records, account
opening money and business audit entries are cleared. Users, roles,
permissions, preferences, settings, cash/bank account definitions, expense
categories, numbering counters and migration history remain. Existing document
files and backup/configuration directories remain intact. `--report` is optional;
`--backup-directory` can select an alternative backup folder.

## Where things live

| Concern | Location |
|---|---|
| Business rules | `src/main/services/**` — the only place a rule may live |
| Persistence | `src/main/repositories/**`, `src/main/db/**` |
| Privileged surface | `src/shared/constants/channels.ts` (the complete list) |
| Permission enforcement | `src/main/ipc/guard.ts` + `src/main/permissions/` |
| Documents & printing | `src/main/reports/`, `src/main/services/documents/` |
| UI | `src/renderer/**` — display only, no authoritative logic |

## Windows x64 test installer

From a clean Windows x64 checkout, run `npm ci`, then `npm run build:win`.
The unsigned NSIS installer is written to
`release/AURA-home-TEST-Setup-0.1.0.exe`. The manual GitHub Actions workflow
`Windows x64 test installer` runs checks, verifies the native SQLite module
and packaged resources, uploads that `.exe` as the `AURA-home-Windows-x64-test`
artifact, then creates a private TEST pre-release with the `.exe` attached.
Windows laptop qualification and BDR-01 remain pending.
