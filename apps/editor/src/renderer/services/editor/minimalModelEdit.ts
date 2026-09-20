/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  minimalModelEdit — reconcile an open text model to new content with a single
 *  minimal edit instead of `setValue`. `setValue` flushes the model (fires a
 *  content change with `isFlush`), which makes Monaco's folding/decoration
 *  controllers drop all collapsed regions. A normal edit that touches only the
 *  changed span keeps every line outside it untouched, so folding there survives
 *  — exactly what an external reload of an unedited config file should do.
 *
 *  交给模型的差异段必须是副本而不是切片的视图：piece tree 会原样持有它直到文档关闭
 *  （见 `detachView`）。
 *--------------------------------------------------------------------------------------------*/

export interface MinimalTextEdit {
  /** Character offset into the old text where the replacement starts. */
  readonly start: number
  /** Character offset into the old text where the replacement ends (exclusive). */
  readonly end: number
  /** Text inserted in place of `[start, end)`. */
  readonly text: string
}

/** 每块 8192 码元：中间数组的大小与文本长度无关，结果的堆碎片是「几块」而不是上千块。 */
const COPY_CHUNK_CHARS = 8192

/**
 * `view` 的副本：字符数据属于副本自己，没有任何一片指向 `view` 的父串。
 *
 * `String.prototype.slice` 返回的是视图（`SlicedString`，只记父串上的偏移），父串在视图活着时
 * 无法回收；而 `pushEditOperations` 交出去的字符串会被 piece tree 原样持有到文档关闭。按**码元**
 * 重建即可断开这层指向：代理对被拆成两半再按原序拼回，孤立代理项原样穿过（`TextEncoder`/`Buffer`
 * 会把孤立代理项换成 U+FFFD）。代价是一趟 O(差异段) 的拷贝，与父串大小无关。
 */
export function detachView(view: string): string {
  let out = ''
  for (let i = 0; i < view.length; i += COPY_CHUNK_CHARS) {
    out += view
      .slice(i, i + COPY_CHUNK_CHARS)
      .split('')
      .join('')
  }
  return out
}

/**
 * The single contiguous span that differs between `oldText` and `newText`,
 * trimming the shared prefix and suffix (UTF-16 code units). Returns null when
 * the texts are identical. `oldText.slice(0, start) + text + oldText.slice(end)`
 * always reconstructs `newText`.
 *
 *  `text` 是 `detachView` 出来的副本，不是 `newText` 的视图（理由见 `detachView`）。
 */
export function computeMinimalTextEdit(oldText: string, newText: string): MinimalTextEdit | null {
  if (oldText === newText) return null
  const oldLen = oldText.length
  const newLen = newText.length

  let prefix = 0
  const maxPrefix = Math.min(oldLen, newLen)
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++

  let suffix = 0
  const maxSuffix = Math.min(oldLen - prefix, newLen - prefix)
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++
  }

  return {
    start: prefix,
    end: oldLen - suffix,
    text: detachView(newText.slice(prefix, newLen - suffix)),
  }
}

interface IPositionLike {
  readonly lineNumber: number
  readonly column: number
}

/** 模型报告自身行尾的切片；报告不了的模型退回逐字节比较。 */
export interface IModelEolSource {
  getEOL?(): string
}

/**
 * 把 `text` 的行尾统一成 `model` 缓冲区存储的那一种。
 *
 * 一个 piece tree 整个文件只有一种行尾，盘上的字节却可以混写（外部进程写的日志就是 CRLF 混少量
 * 裸 LF）：拿 `getValue()` 与原始盘上文本逐字节比对会把整篇报成变更，于是每次刷新都推一份近全文
 * 的编辑。只改**进来的文本**，绝不改模型的 EOL；行尾本就不需要改写时返回同一个字符串，而不是为了
 * 判断而复制一份。BOM 不在职责内（调用方已在读盘处摘掉）。
 */
export function normalizeToModelEol(text: string, model?: IModelEolSource): string {
  const eol = model?.getEOL?.()
  if (eol !== '\r\n' && eol !== '\n') return text
  return hasForeignEol(text, eol) ? text.replace(/\r\n|\r|\n/g, eol) : text
}

/** 文本里有没有非 `eol` 的行尾？先扫一遍比直接重写便宜。 */
function hasForeignEol(text: string, eol: '\r\n' | '\n'): boolean {
  if (eol === '\n') {
    // 裸 CR 与 CRLF 都要改写
    return text.includes('\r')
  }
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i === 0 || text.charCodeAt(i - 1) !== 13 /* CR */) return true
  }
  for (let i = text.indexOf('\r'); i !== -1; i = text.indexOf('\r', i + 1)) {
    if (i + 1 >= text.length || text.charCodeAt(i + 1) !== 10 /* LF */) return true
  }
  return false
}

/** The slice of `monaco.editor.ITextModel` this module needs. Signatures are
 *  intentionally loose so the real model (and a test fake) both satisfy it. */
export interface IEditableTextModel extends IModelEolSource {
  getValue(): string
  setValue(value: string): void
  getPositionAt?(offset: number): IPositionLike
  pushEditOperations?(
    base: never[] | null,
    edits: Array<{
      range: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      }
      text: string
    }>,
    cursorComputer: () => null,
  ): unknown
}

export type ApplyResult = 'edited' | 'noop' | 'replaced'

/**
 * Update `model` to `newText`. Prefers a single minimal edit (preserving folding
 * outside the change); returns 'edited'. Returns 'noop' when already equal, and
 * falls back to `setValue` (returning 'replaced') when the model lacks the edit
 * APIs.
 *
 * `newText` 先按模型的行尾归一化（见 `normalizeToModelEol`），比对与偏移因此都在**模型的**坐标系里：
 * 编辑偏移和把它变成 range 的 `getPositionAt` 都读自模型，不读盘上文本。
 */
export function applyMinimalTextEdit(model: IEditableTextModel, newText: string): ApplyResult {
  const text = normalizeToModelEol(newText, model)
  const edit = computeMinimalTextEdit(model.getValue(), text)
  if (!edit) return 'noop'
  if (typeof model.getPositionAt !== 'function' || typeof model.pushEditOperations !== 'function') {
    model.setValue(text)
    return 'replaced'
  }
  const startPos = model.getPositionAt(edit.start)
  const endPos = model.getPositionAt(edit.end)
  model.pushEditOperations(
    null,
    [
      {
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
        text: edit.text,
      },
    ],
    () => null,
  )
  return 'edited'
}
