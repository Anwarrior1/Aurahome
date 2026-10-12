# brand/

`logo-full.jpeg` — the original AURA home logo (source: `logo/logo.jpeg`
at the project root; kept here as the copy the packaged app actually
bundles and the copy `app://assets/brand/...` resolves at runtime).

**Pending, not yet generated** — this is a production asset-prep task
flagged in Step 2 §12, not an open design decision:

- `logo-full.png` — transparent-background version
- `logo-mono-light.png` — knockout variant for the dark espresso sidebar
- `app-icon.ico` — Windows window/taskbar/installer icon

`electron-builder.yml` references `app-icon.ico` for the Windows build
— generate it here before running `npm run build:win`.
