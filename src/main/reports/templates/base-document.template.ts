/**
 * Every printable document template returns HTML that:
 *   - sets dir="rtl" lang="ar"
 *   - loads Cairo via app://assets/fonts/fonts.css (never a system or
 *     remote font)
 *   - reuses the same design tokens as the renderer UI (see
 *     src/renderer/theme/tokens.css) so screen and paper stay
 *     consistent (explicit Step 2 requirement)
 *
 * Concrete templates (Preliminary Invoice, Final Invoice, Work Sheet,
 * Installation Authorization, Delivery Release, reports) are built on
 * top of this shell in Step 4/5, each consuming one of the DTOs in
 * src/main/reports/dto.
 */
export function renderDocumentShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <link rel="stylesheet" href="app://assets/fonts/fonts.css" />
  <style>
    body { font-family: 'Cairo', sans-serif; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`
}
