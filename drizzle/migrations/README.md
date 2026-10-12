# AURA database migration history

Drizzle SQL migrations and `meta/_journal.json` are committed production
history. Once released, an existing migration, its journal entry, timestamp,
ordering, or hash must never be edited. Schema changes are appended with
`npm run db:generate`, reviewed, and then added to the pinned compatibility
catalog in `src/main/migrations/migration-history.ts`.

Application startup applies migrations only through
`src/main/migrations/migration-runner.ts`. The runner accepts an empty fresh
database or an exact canonical journal prefix from migration `0000` through the
current head. A nonempty database without trustworthy journal evidence, a
future entry, a gap, reordered history, a changed hash, or an unrecognized
entry is rejected before schema mutation. Released SQL is also checked against
the pinned catalog before a database is opened for migration.

Every file-backed, nonempty historical database receives DB-01's validated and
durably published pre-migration recovery snapshot before migration starts.
Successful SQL execution is followed by exact journal, SQLite integrity,
foreign-key, required schema object, constraint, and bounded migration business
invariant verification. The recovery marker is finalized only after the normal
startup initialization path and window creation succeed.

Do not run these files manually against a production database and do not repair
an incompatible database by deleting or rewriting its Drizzle journal.
