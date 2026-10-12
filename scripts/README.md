# scripts/

Build/asset helper scripts (e.g. deriving `app-icon.ico` and the
transparent/mono logo variants from `resources/assets/brand/logo-full.jpeg`,
see that folder's README) land here as they're needed. None required
to reach a running `npm run dev` in Step 3.

`reset-business-data.mjs` is a source-tree-only development utility. It
requires an absolute database path and the literal confirmation token:

```sh
npm run reset:business-data -- --database "/absolute/path/to/erp.db" --confirm RESET-DEVELOPMENT-BUSINESS-DATA
```

It creates a pre-reset SQLite backup, keeps foreign-key enforcement on,
and refuses production or unconfirmed invocation.
