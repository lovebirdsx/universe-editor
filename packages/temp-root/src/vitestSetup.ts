import { createRunRoot, installRunTempEnv, removeRunRoot } from './index.js'

/**
 * vitest globalSetup：为一次测试运行建专属临时根并把 TEMP/TMP/TMPDIR 指过去。
 * globalSetup 在 worker fork 之前跑，所以 process.env 的改动会被所有 worker 与被测进程继承
 * ——各处 `os.tmpdir()` 自动跟随，无需逐个调用点改造。返回的函数在整轮结束后删掉整个 run 根，
 * 于是单次运行对临时根是净零的（崩溃留下的残根由 `pnpm tmp:clean` 按 TTL 回收）。
 */
export default function setup(): () => void {
  const root = createRunRoot('ue-run')
  installRunTempEnv(root)
  let removed = false
  const cleanup = (): void => {
    if (removed) return
    removed = true
    removeRunRoot(root)
  }
  // Backstop: a suite that calls process.exit() skips vitest's teardown entirely.
  // exit handlers run synchronously, which is all removeRunRoot needs.
  process.once('exit', cleanup)
  return cleanup
}
