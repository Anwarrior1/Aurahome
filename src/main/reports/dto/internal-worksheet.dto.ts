/**
 * The internal FACTORY instruction document ("أمر تصنيع").
 *
 * Item 14: this type carries NO monetary field at all — no material
 * price, no machine cost, no labour entitlement, no selling price, no
 * profit. The factory needs to know WHAT to build and WHICH materials
 * to use; the company's financials stay inside the ERP, visible to
 * authorised users on screen. As with CustomerDocumentDTO, the type
 * itself is the guarantee: a template cannot print a field that does
 * not exist.
 */
export interface InternalWorkSheetDTO {
  /** Non-financial source lines preserve the historical screen as well as the print. */
  sourceLines?: Array<{ id: number; description: string; quantityMicro: number; dimensions: string | null; colorCode: string | null; accessories: string | null; specifications: string | null }>
  documentNumber: string
  orderNumber: string
  customerReference: string
  issuedAt: string
  status: string
  items: Array<{
    product: string
    materialCategory: string
    materialType?: string
    colorCode?: string
    quantity: string
    dimensions?: string
    specifications?: string
    accessories?: string[]
  }>
  /** "المواد المطلوبة للتصنيع" — quantities and specs only, never cost. */
  requiredMaterials: Array<{
    material: string
    quantity: string
    unit?: string
    dimensions?: string
    thickness?: string
    colorCode?: string
    notes?: string
  }>
  /**
   * "الآلات المطلوبة للتصنيع" — which machines/processes the job is
   * expected to need. Names and planned usage only; there is
   * deliberately no cost field here, so no template change can print
   * a machine rate on a factory document.
   */
  requiredMachines: Array<{
    machine: string
    usage?: string
    notes?: string
  }>
  assignedWorkers: string[]
  manufacturingNotes?: string
  /** Delivery/installation requirement, useful for factory planning. */
  fulfillmentRequirement?: string
}
