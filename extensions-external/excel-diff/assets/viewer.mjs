/*
 * Excel viewer webview renderer. Reads the JSON payload the extension embedded
 * (single-workbook view OR a computed diff model) and paints it. No parsing here
 * — SheetJS ran host-side; this is a thin painter with sheet tabs + a
 * "changes only" filter for diffs.
 */

const payload = JSON.parse(document.getElementById('excel-payload').textContent)

const toolbar = document.getElementById('toolbar')
const tabsEl = document.getElementById('tabs')
const gridEl = document.getElementById('grid')

let activeSheet = 0
let changesOnly = false

/** Column letter for a 0-based index (0→A, 26→AA), like a spreadsheet header. */
function colName(index) {
  let n = index
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderError(message) {
  gridEl.appendChild(el('div', 'error', message))
}

// ---- Single-workbook view ----

function renderWorkbookView() {
  const wb = payload.workbook
  toolbar.appendChild(el('span', 'title', payload.title))
  renderSheetTabs(
    wb.sheets.map((s) => ({ name: s.name, status: 'equal', changeCount: 0 })),
    renderSheet,
  )
  renderSheet()

  function renderSheet() {
    gridEl.replaceChildren()
    const sheet = wb.sheets[activeSheet]
    if (!sheet || sheet.rows === 0) {
      gridEl.appendChild(el('div', 'error', 'Empty sheet.'))
      return
    }
    const table = el('table')
    const thead = el('thead')
    const hr = el('tr')
    hr.appendChild(el('th', 'rownum', ''))
    for (let c = 0; c < sheet.cols; c++) hr.appendChild(el('th', null, colName(c)))
    thead.appendChild(hr)
    table.appendChild(thead)
    const tbody = el('tbody')
    sheet.cells.forEach((row, r) => {
      const tr = el('tr')
      tr.appendChild(el('td', 'rownum', String(r + 1)))
      for (let c = 0; c < sheet.cols; c++) tr.appendChild(el('td', null, row[c] ?? ''))
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    gridEl.appendChild(table)
  }
}

// ---- Diff view ----

function renderDiffView() {
  const model = payload.diff
  toolbar.appendChild(el('span', 'title', payload.title))

  const legend = el('div', 'legend')
  legend.append(
    swatch('var(--added-bg)', 'Added'),
    swatch('var(--removed-bg)', 'Removed'),
    swatch('var(--modified-bg)', 'Modified'),
  )
  const filterBtn = el('button', null, 'Changes only')
  filterBtn.addEventListener('click', () => {
    changesOnly = !changesOnly
    filterBtn.classList.toggle('active', changesOnly)
    renderSheet()
  })
  toolbar.append(filterBtn, legend)

  renderSheetTabs(model.sheets, renderSheet)
  renderSheet()

  function renderSheet() {
    gridEl.replaceChildren()
    const sheet = model.sheets[activeSheet]
    if (!sheet) {
      gridEl.appendChild(el('div', 'error', 'No sheet.'))
      return
    }
    const table = el('table')
    const thead = el('thead')
    const hr = el('tr')
    hr.appendChild(el('th', 'rownum', ''))
    // Two column blocks: left (baseline) then right (modified).
    for (let c = 0; c < sheet.cols; c++) hr.appendChild(el('th', null, `${colName(c)} ◂`))
    for (let c = 0; c < sheet.cols; c++) hr.appendChild(el('th', null, `▸ ${colName(c)}`))
    thead.appendChild(hr)
    table.appendChild(thead)

    const tbody = el('tbody')
    for (const drow of sheet.rows) {
      if (changesOnly && drow.kind === 'equal') continue
      const tr = el('tr', drow.kind)
      const num =
        drow.rightIndex !== undefined
          ? drow.rightIndex + 1
          : drow.leftIndex !== undefined
            ? drow.leftIndex + 1
            : ''
      tr.appendChild(el('td', 'rownum', String(num)))
      const changed = new Set(drow.changed)
      for (let c = 0; c < sheet.cols; c++) {
        const hasLeft = drow.left !== undefined
        const cell = el('td', hasLeft ? null : 'side-empty', hasLeft ? (drow.left[c] ?? '') : '')
        if (drow.kind === 'modified' && changed.has(c)) cell.classList.add('changed')
        tr.appendChild(cell)
      }
      for (let c = 0; c < sheet.cols; c++) {
        const hasRight = drow.right !== undefined
        const cell = el('td', hasRight ? null : 'side-empty', hasRight ? (drow.right[c] ?? '') : '')
        if (drow.kind === 'modified' && changed.has(c)) cell.classList.add('changed')
        tr.appendChild(cell)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    gridEl.appendChild(table)
  }
}

function swatch(color, label) {
  const wrap = el('span')
  const sw = el('span', 'swatch')
  sw.style.background = color
  wrap.append(sw, document.createTextNode(label))
  return wrap
}

/** Render clickable sheet tabs; `onSelect` runs after `activeSheet` changes. */
function renderSheetTabs(sheets, onSelect) {
  tabsEl.replaceChildren()
  sheets.forEach((sheet, i) => {
    const tab = el('div', `tab ${sheet.status ?? 'equal'}`)
    tab.appendChild(document.createTextNode(sheet.name))
    if (sheet.changeCount > 0) tab.appendChild(el('span', 'badge', String(sheet.changeCount)))
    if (i === activeSheet) tab.classList.add('active')
    tab.addEventListener('click', () => {
      activeSheet = i
      for (const t of tabsEl.children) t.classList.remove('active')
      tab.classList.add('active')
      onSelect()
    })
    tabsEl.appendChild(tab)
  })
}

if (payload.mode === 'error') renderError(payload.message)
else if (payload.mode === 'diff') renderDiffView()
else renderWorkbookView()
