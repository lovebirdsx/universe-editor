/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  合并补丁稿的分段元数据契约（compiler → main → renderer 共用）。compile.mjs 按字符偏移
 *  给出每段起点，渲染端据此切正文、给每段的链接选定回退版本；不再按标题文案识别。
 *--------------------------------------------------------------------------------------------*/

/** 一段的起点：`offset` 是 body 内的字符下标，首段为 0。 */
export interface IReleaseNoteBodySection {
  readonly version: string
  readonly offset: number
}

export interface IBodySectionsCheck {
  readonly sections?: readonly IReleaseNoteBodySection[]
  /** 元数据非法时的诊断（调用方保留正文、退回单段）。 */
  readonly problem?: string
}

function compareDotted(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/**
 * 校验分段元数据：偏移是 body 内非负整数、严格递增且在正文范围内；首段是主稿且 offset=0；
 * 后段版本升序且大于主稿。缺省（普通稿）返回空对象，非法返回 problem 让调用方安全退回单段。
 */
export function normalizeBodySections(
  value: unknown,
  noteVersion: string,
  body: string,
): IBodySectionsCheck {
  if (value === undefined) return {}
  if (!Array.isArray(value)) return { problem: 'bodySections 不是数组' }
  if (value.length === 0) return { problem: 'bodySections 为空' }
  const sections: IReleaseNoteBodySection[] = []
  let previousOffset = -1
  let previousVersion = ''
  for (let i = 0; i < value.length; i++) {
    const where = `bodySections 第 ${i + 1} 段`
    const raw = value[i]
    if (raw === null || typeof raw !== 'object') return { problem: `${where}不是对象` }
    const { version, offset } = raw as { version?: unknown; offset?: unknown }
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
      return { problem: `${where} version 非法：${String(version)}` }
    }
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      return { problem: `${where} offset 必须是非负整数：${String(offset)}` }
    }
    if (offset <= previousOffset) {
      return { problem: `${where} offset 未严格递增：${previousOffset} → ${offset}` }
    }
    if (offset >= body.length) {
      return { problem: `${where} offset 超出正文范围：${offset} >= ${body.length}` }
    }
    if (i === 0) {
      if (offset !== 0) return { problem: `bodySections 首段 offset 必须为 0：${offset}` }
      if (version !== noteVersion) {
        return { problem: `bodySections 首段 version ${version} 必须是主稿版本 ${noteVersion}` }
      }
    } else if (compareDotted(version, noteVersion) <= 0) {
      return { problem: `${where} version ${version} 必须大于主稿 ${noteVersion}` }
    } else if (compareDotted(version, previousVersion) <= 0) {
      return { problem: `${where} version 未升序：${previousVersion} → ${version}` }
    }
    previousOffset = offset
    previousVersion = version
    sections.push({ version, offset })
  }
  return { sections }
}
