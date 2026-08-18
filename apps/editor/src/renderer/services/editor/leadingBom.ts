/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  leadingBom — UTF-8 BOM split helper shared by every input that reads a file
 *  from disk (FileEditorInput, and DiffEditorInput's editable modified side).
 *--------------------------------------------------------------------------------------------*/

export const UTF8_BOM = '\uFEFF'

/** Strip a single leading UTF-8 BOM so the editor baseline compares cleanly
 *  against Monaco's BOM-free buffer; `hadBom` lets save() re-add it. */
export function splitLeadingBom(text: string): { text: string; hadBom: boolean } {
  return text.startsWith(UTF8_BOM)
    ? { text: text.slice(UTF8_BOM.length), hadBom: true }
    : { text, hadBom: false }
}
