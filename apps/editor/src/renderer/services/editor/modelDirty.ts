/*---------------------------------------------------------------------------------------------
 *  modelDirty — decide whether an open Monaco buffer is back at its clean baseline.
 *
 *  Monaco 的 alternativeVersionId 只在 undo/redo 时回退；IME 取消组合是「插入预编辑
 *  文本 + 删除它」两次普通编辑，版本号前进而内容回到保存态。版本号相等仍是 O(1) 的
 *  干净快路径，不等时用长度预筛 + 内容比较兜底。
 *--------------------------------------------------------------------------------------------*/

/** The slice of `monaco.editor.ITextModel` this module needs. Signatures are
 *  intentionally loose so the real model (and a test fake) both satisfy it. */
export interface IDirtyComparableModel {
  getAlternativeVersionId(): number
  getValueLength(): number
  getValue(): string
  /** Monaco 内部堆保护方法；真模型有，测试 fake 可缺省。 */
  isTooLargeForHeapOperation?(): boolean
}

/**
 * Whether `model` still matches the saved version. `cleanContent` must be in the
 * model's EOL form (both baselines are written from `model.getValue()` /
 * `normalizeToModelEol`, so this holds at every call site).
 */
export function isModelAtCleanVersion(
  model: IDirtyComparableModel,
  savedAlternativeVersionId: number,
  cleanContent: string,
): boolean {
  if (model.getAlternativeVersionId() === savedAlternativeVersionId) return true
  // 长度不同必然不是干净基线，而且 O(1)：普通输入与 IME 预编辑增长都走这里，不复制全文。
  if (model.getValueLength() !== cleanContent.length) return false
  // 超大模型拒绝 getValue()（Monaco 的堆保护）；按旧语义视为 dirty 而不是抛错。
  if (model.isTooLargeForHeapOperation?.()) return false
  return model.getValue() === cleanContent
}
