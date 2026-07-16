/*
 * Spreadsheet parsing (SheetJS) → a plain, JSON-serializable model the webview
 * renders. Parsing runs host-side (in the extension, where the raw bytes arrive)
 * so the webview stays a thin painter and SheetJS is bundled once into the node
 * extension rather than shipped as a browser build.
 */
import * as XLSX from 'xlsx'

/** One parsed sheet: a dense 2-D grid of display strings + the raw cell values. */
export interface SheetModel {
  readonly name: string
  /** Display text per cell, row-major. Ragged rows are padded to `cols`. */
  readonly cells: string[][]
  readonly rows: number
  readonly cols: number
}

export interface WorkbookModel {
  readonly sheets: SheetModel[]
}

/** Format a SheetJS cell to the text we show/diff. Prefers the formatted text
 *  (`w`) so dates/numbers match what a spreadsheet app shows; falls back to the
 *  raw value. Empty/missing cells become ''. */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return ''
  if (typeof cell.w === 'string') return cell.w
  if (cell.v === undefined || cell.v === null) return ''
  if (cell.v instanceof Date) return cell.v.toISOString()
  return String(cell.v)
}

function sheetToModel(name: string, sheet: XLSX.WorkSheet): SheetModel {
  const ref = sheet['!ref']
  if (!ref) return { name, cells: [], rows: 0, cols: 0 }
  const range = XLSX.utils.decode_range(ref)
  const rows = range.e.r - range.s.r + 1
  const cols = range.e.c - range.s.c + 1
  const cells: string[][] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      row.push(cellText(sheet[addr] as XLSX.CellObject | undefined))
    }
    cells.push(row)
  }
  return { name, cells, rows, cols }
}

/** Parse spreadsheet bytes into the render model. Throws on unreadable input. */
export function parseWorkbook(bytes: Uint8Array): WorkbookModel {
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true, cellText: true })
  const sheets = wb.SheetNames.map((sheetName) => {
    const sheet = wb.Sheets[sheetName]
    return sheet ? sheetToModel(sheetName, sheet) : { name: sheetName, cells: [], rows: 0, cols: 0 }
  })
  return { sheets }
}
