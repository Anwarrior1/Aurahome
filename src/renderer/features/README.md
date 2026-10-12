# features/

Feature-scoped UI logic that composes `pages/` and `components/ui` for
one of the 30 confirmed modules (e.g. `features/quotations`,
`features/inventory`). A feature hook may call `window.erp.<module>.*`
and hold UI state, but it never computes a financial or inventory
value itself — it displays what main returned. Built out
module-by-module starting in Step 4.
