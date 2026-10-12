import { sqliteTable, integer, text, uniqueIndex, foreignKey } from 'drizzle-orm/sqlite-core'
import { quotationLines, finalInvoiceLines, orderLines } from './sales.schema'
import { materials, colorFinishCatalog } from './catalog.schema'

// Child rows are document-owned; catalog deletion clears only the reference,
// preserving the original document wording. Legacy text has a null reference.
export const quotationLineMaterials = sqliteTable(
  'quotation_line_materials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => quotationLines.id, { onDelete: 'cascade' }),
    materialId: integer('material_id').references(() => materials.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    nameSnapshot: text('name_snapshot').notNull()
  },
  (t) => ({
    ownerUnique: uniqueIndex('quotation_line_materials_owner_uq').on(t.id, t.lineId),
    referenceUnique: uniqueIndex('quotation_line_materials_reference_uq').on(
      t.lineId,
      t.materialId
    ),
    positionUnique: uniqueIndex('quotation_line_materials_position_uq').on(t.lineId, t.position)
  })
)

export const quotationLineColors = sqliteTable(
  'quotation_line_colors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => quotationLines.id, { onDelete: 'cascade' }),
    materialSelectionId: integer('material_selection_id'),
    colorId: integer('color_id').references(() => colorFinishCatalog.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    codeSnapshot: text('code_snapshot').notNull(),
    nameSnapshot: text('name_snapshot')
  },
  (t) => ({
    materialOwnerFk: foreignKey({ columns: [t.materialSelectionId, t.lineId], foreignColumns: [quotationLineMaterials.id, quotationLineMaterials.lineId] }).onDelete('cascade'),
    referenceUnique: uniqueIndex('quotation_line_colors_reference_uq').on(t.lineId, t.colorId),
    positionUnique: uniqueIndex('quotation_line_colors_position_uq').on(t.lineId, t.position)
  })
)

export const quotationLineAccessories = sqliteTable(
  'quotation_line_accessories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => quotationLines.id, { onDelete: 'cascade' }),
    materialId: integer('material_id').references(() => materials.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    nameSnapshot: text('name_snapshot').notNull()
  },
  (t) => ({
    referenceUnique: uniqueIndex('quotation_line_accessories_reference_uq').on(
      t.lineId,
      t.materialId
    ),
    positionUnique: uniqueIndex('quotation_line_accessories_position_uq').on(t.lineId, t.position)
  })
)

export const finalInvoiceLineMaterials = sqliteTable(
  'final_invoice_line_materials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => finalInvoiceLines.id, { onDelete: 'cascade' }),
    materialId: integer('material_id').references(() => materials.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    nameSnapshot: text('name_snapshot').notNull()
  },
  (t) => ({
    ownerUnique: uniqueIndex('final_invoice_line_materials_owner_uq').on(t.id, t.lineId),
    referenceUnique: uniqueIndex('final_invoice_line_materials_reference_uq').on(
      t.lineId,
      t.materialId
    ),
    positionUnique: uniqueIndex('final_invoice_line_materials_position_uq').on(t.lineId, t.position)
  })
)

export const finalInvoiceLineColors = sqliteTable(
  'final_invoice_line_colors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => finalInvoiceLines.id, { onDelete: 'cascade' }),
    materialSelectionId: integer('material_selection_id'),
    colorId: integer('color_id').references(() => colorFinishCatalog.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    codeSnapshot: text('code_snapshot').notNull(),
    nameSnapshot: text('name_snapshot')
  },
  (t) => ({
    materialOwnerFk: foreignKey({ columns: [t.materialSelectionId, t.lineId], foreignColumns: [finalInvoiceLineMaterials.id, finalInvoiceLineMaterials.lineId] }).onDelete('cascade'),
    referenceUnique: uniqueIndex('final_invoice_line_colors_reference_uq').on(t.lineId, t.colorId),
    positionUnique: uniqueIndex('final_invoice_line_colors_position_uq').on(t.lineId, t.position)
  })
)

export const finalInvoiceLineAccessories = sqliteTable(
  'final_invoice_line_accessories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => finalInvoiceLines.id, { onDelete: 'cascade' }),
    materialId: integer('material_id').references(() => materials.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    nameSnapshot: text('name_snapshot').notNull()
  },
  (t) => ({
    referenceUnique: uniqueIndex('final_invoice_line_accessories_reference_uq').on(
      t.lineId,
      t.materialId
    ),
    positionUnique: uniqueIndex('final_invoice_line_accessories_position_uq').on(
      t.lineId,
      t.position
    )
  })
)

export const orderLineMaterials = sqliteTable(
  'order_line_materials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => orderLines.id, { onDelete: 'cascade' }),
    materialId: integer('material_id').references(() => materials.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    nameSnapshot: text('name_snapshot').notNull()
  },
  (t) => ({
    ownerUnique: uniqueIndex('order_line_materials_owner_uq').on(t.id, t.lineId),
    referenceUnique: uniqueIndex('order_line_materials_reference_uq').on(t.lineId, t.materialId),
    positionUnique: uniqueIndex('order_line_materials_position_uq').on(t.lineId, t.position)
  })
)

export const orderLineColors = sqliteTable(
  'order_line_colors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => orderLines.id, { onDelete: 'cascade' }),
    materialSelectionId: integer('material_selection_id'),
    colorId: integer('color_id').references(() => colorFinishCatalog.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    codeSnapshot: text('code_snapshot').notNull(),
    nameSnapshot: text('name_snapshot')
  },
  (t) => ({
    materialOwnerFk: foreignKey({ columns: [t.materialSelectionId, t.lineId], foreignColumns: [orderLineMaterials.id, orderLineMaterials.lineId] }).onDelete('cascade'),
    referenceUnique: uniqueIndex('order_line_colors_reference_uq').on(t.lineId, t.colorId),
    positionUnique: uniqueIndex('order_line_colors_position_uq').on(t.lineId, t.position)
  })
)

export const orderLineAccessories = sqliteTable(
  'order_line_accessories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lineId: integer('line_id')
      .notNull()
      .references(() => orderLines.id, { onDelete: 'cascade' }),
    materialId: integer('material_id').references(() => materials.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    nameSnapshot: text('name_snapshot').notNull()
  },
  (t) => ({
    referenceUnique: uniqueIndex('order_line_accessories_reference_uq').on(t.lineId, t.materialId),
    positionUnique: uniqueIndex('order_line_accessories_position_uq').on(t.lineId, t.position)
  })
)
