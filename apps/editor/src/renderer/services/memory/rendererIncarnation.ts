/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  每次启动的 renderer 身份。main 会给每个堆样本盖上窗口 id、PID 和导航代次，但都区分不出
 *  一个*迟到*的样本和一个新鲜的样本：被 reload 顶掉的 renderer 发出的报告，到达时窗口 id 相同、
 *  代次也已经是新的，会像在描述新堆一样落进新一轮的基线。
 *
 *  incarnation 每个 JS 上下文只生成一次且不复用，main 便能丢掉 incarnation 与本轮绑定的那个
 *  不一致的样本。
 *--------------------------------------------------------------------------------------------*/

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const RANDOM_LENGTH = 4

/**
 * 格式是有约束的：main 用 `/^[a-z0-9-]{1,40}$/i` 过一遍才会让它接近判断，形状不符即视为
 * 「没有 incarnation」。36 进制的起始时间前缀是给人看日志的（不是排序键，跨位数不保序），
 * 随机后缀保证同一毫秒启动的两个上下文不会撞。
 */
export function createRendererIncarnation(
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  let suffix = ''
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    const index = Math.floor(random() * RANDOM_ALPHABET.length)
    suffix += RANDOM_ALPHABET[Math.min(RANDOM_ALPHABET.length - 1, Math.max(0, index))]
  }
  return `r${now.toString(36)}-${suffix}`
}

/**
 * 本 renderer 的身份。模块级正是对的生命周期：reload 会重跑整包，新上下文绝不能长得像旧的。
 */
export const RENDERER_INCARNATION = createRendererIncarnation()
