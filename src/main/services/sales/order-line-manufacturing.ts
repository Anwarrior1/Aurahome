interface CurrentLine {
  lineKind: string
  supersededAt: string | null
  uncollectedProductId: number | null
}

/**
 * BL-04: only a custom line is customer manufacturing demand. A standard
 * line is fulfilled from ready finished goods only (isStandardStockLine), and
 * an Uncollected resale line already represents a physical product.
 */
export function isManufacturableOrderLine(line: CurrentLine): boolean {
  return line.lineKind === 'custom' && line.supersededAt === null && line.uncollectedProductId === null
}

/** A current standard-product line, supplied from ready finished-goods stock. */
export function isStandardStockLine(line: CurrentLine & { productId: number | null }): boolean {
  return line.lineKind === 'standard' && line.productId !== null && line.supersededAt === null && line.uncollectedProductId === null
}
