/**
 * Print stylesheet shared by every document template. Mirrors the
 * Step 2 §11 design tokens so paper output and the on-screen UI stay
 * visually consistent, and always renders in the light/print palette
 * regardless of the user's UI theme (AD-4).
 */
export const DOCUMENT_STYLES = `
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Cairo', sans-serif;
    color: #211E1B;
    background: #FFFFFF;
    margin: 0;
    font-size: 12px;
    line-height: 1.7;
    font-variant-numeric: tabular-nums;
  }
  .doc-header {
    display: flex; align-items: flex-start; justify-content: space-between;
    border-bottom: 2px solid #94877C; padding-bottom: 10px; margin-bottom: 14px;
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand img { width: 64px; height: 64px; object-fit: contain; }
  .brand-name { font-weight: 600; font-size: 18px; letter-spacing: .5px; }
  .brand-meta { color: #6B625B; font-size: 11px; }
  .doc-title { text-align: left; }
  .doc-title h1 { margin: 0; font-size: 17px; font-weight: 600; }
  .doc-title .num { color: #6B5D51; font-weight: 600; margin-top: 2px; }
  .doc-title .date { color: #6B625B; font-size: 11px; }
  .internal-badge {
    display: inline-block; margin-top: 4px; padding: 2px 8px; border-radius: 4px;
    background: #F1EEEB; border: 1px solid #D2CBC4; color: #4F4842;
    font-size: 10px; font-weight: 600;
  }
  .party { background: #F8F6F4; border: 1px solid #E4DFDA; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
  .party .row { display: flex; gap: 24px; flex-wrap: wrap; }
  .label { color: #6B625B; font-size: 11px; }
  .value { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th { background: #F1EEEB; font-weight: 600; font-size: 11px; text-align: right; padding: 7px 8px; border: 1px solid #E4DFDA; }
  td { padding: 7px 8px; border: 1px solid #E4DFDA; vertical-align: top; }
  td.num, th.num { text-align: left; white-space: nowrap; }
  .spec { color: #6B625B; font-size: 10.5px; }
  /* Item specifications — a dedicated box below the item row, visually
     separate from "البيان" (same treatment as .party: light fill,
     hairline border, rounded corners). Sits in its own <tr> so it
     spans the row's full content width and grows/paginates as a
     normal table row rather than a fixed-height cell. */
  tr.spec-row td { border-top: none; padding-top: 0; }
  .spec-box { background: #F8F6F4; border: 1px solid #E4DFDA; border-radius: 6px; padding: 6px 10px; }
  .spec-box .spec-label { color: #6B5D51; font-size: 10px; font-weight: 600; margin-bottom: 3px; }
  .spec-box .spec { margin: 1px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .material-color-group + .material-color-group { margin-top: 5px; }
  .totals { width: 46%; margin-right: auto; }
  .totals td { border: none; padding: 4px 8px; }
  .totals tr.grand td { border-top: 2px solid #94877C; font-weight: 600; font-size: 14px; padding-top: 8px; }
  .totals tr.deposit td { color: #6B5D51; font-weight: 600; }
  /* Fulfilment statements — short factual chips under the totals, in
     the same soft language as .spec-box. Rendered only when the
     document's own boolean says so, so the block simply does not exist
     when nothing applies. (Kept free of the Arabic phrases themselves:
     this stylesheet is inlined into every generated document, so a
     phrase in a comment would appear in the document's own source.) */
  .fulfillment { display: flex; gap: 8px; margin: 4px 0 12px; }
  .fulfillment-item { background: #F1EEEB; border: 1px solid #E4DFDA; border-radius: 4px;
    padding: 4px 10px; font-size: 11px; font-weight: 600; color: #4F4842; }
  /* The quoted per-metre rate: commercial information, deliberately
     outside the totals column so it is never read as one of the
     amounts being added up. */
  .rate-note { display: inline-flex; gap: 8px; align-items: baseline; margin: 4px 0 8px;
    padding: 4px 10px; background: #F8F6F4; border: 1px solid #E4DFDA; border-radius: 4px;
    color: #6B5D51; font-size: 11px; }
  .rate-note-label { font-weight: 600; }
  .rate-note-value { font-weight: 600; }
  .doc-notes { margin-top: 10px; background: #F8F6F4; border: 1px solid #E4DFDA;
    border-radius: 6px; padding: 6px 10px; font-size: 10.5px; color: #4F4842; }
  .doc-notes .doc-notes-label { color: #6B5D51; font-size: 10px; font-weight: 600; margin-bottom: 3px; }
  .terms { margin-top: 16px; border-top: 1px solid #E4DFDA; padding-top: 10px; }
  .terms h3 { font-size: 12px; margin: 0 0 6px; font-weight: 600; }
  .terms ol { margin: 0; padding-right: 18px; color: #4F4842; font-size: 10.5px; line-height: 1.8; }
  .footer { margin-top: 18px; display: flex; justify-content: space-between; color: #6B625B; font-size: 10.5px; }
  .sign { margin-top: 26px; display: flex; justify-content: space-between; }
  .sign div { width: 45%; border-top: 1px solid #D2CBC4; padding-top: 5px; text-align: center; font-size: 11px; }
  .invoice-sign { margin-top: 10px; }
  .invoice-contact-footer {
    direction: rtl; margin-top: 4px; padding-top: 4px; border-top: 1px solid #D2CBC4;
    display: flex; align-items: center; justify-content: space-between; gap: 18px;
    color: #4F4842; font-size: 10.5px; break-inside: avoid; page-break-inside: avoid;
  }
  .invoice-contact-details {
    flex: 1; min-width: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr);
    align-items: center; column-gap: 22px; row-gap: 4px;
  }
  .invoice-contact-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .invoice-contact-row svg {
    width: 13px; height: 13px; flex: 0 0 13px; fill: none; stroke: #6B5D51;
    stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
  }
  .invoice-contact-row svg .icon-fill { fill: #6B5D51; stroke: none; }
  .invoice-contact-row bdi[dir='ltr'] { direction: ltr; unicode-bidi: isolate; white-space: nowrap; }
  .invoice-contact-address span { white-space: normal; }
  .invoice-location-qr {
    flex: 0 0 76px; margin: 0; text-align: center; break-inside: avoid; page-break-inside: avoid;
  }
  .invoice-location-qr img {
    display: block; width: 76px; height: auto; margin: 0 auto 1px;
    object-fit: contain; image-rendering: auto;
  }
  .invoice-location-qr figcaption { color: #6B625B; font-size: 8.5px; line-height: 1.2; white-space: nowrap; }
  .notice { background: #F1EEEB; border-right: 3px solid #2F7D5D; padding: 8px 10px; border-radius: 4px; margin-bottom: 12px; font-weight: 600; }
  .notice.notice--warning { background: #FFF8E7; border-right-color: #A56A14; }
`
