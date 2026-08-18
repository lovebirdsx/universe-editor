# tsgo 幽灵 typecheck 报错：WSL 时钟漂移毒化增量缓存（已根治）

**现象**：`pnpm check` / `pnpm typecheck` 报出与本次改动完全无关的 TS2339/TS2305（如 `ManagedChildProcess` 缺成员、`e2e-contract` 缺导出），但对应上游包源码和 `dist/*.d.ts` 明明都是对的；`pnpm build` 全绿也修不好。也可能反向表现为假绿（漏报新错）。仅 WSL 复现，Windows 正常。

**根因（2026-08 查明）**：WSL2 的 RTC 硬件时钟可能大幅偏移（该机实测快约 24 小时，`timedatectl` 可见 RTC vs 系统时间）。WSL 启动/恢复时内核先用 RTC 初始化系统时间，NTP 稍后才校正回来；窗口内写出的 `*.tsbuildinfo` / dist 产物 mtime 落在"未来"。时钟校正后长达一天内，`tsgo --build` 的 mtime 顺序比较全部失真——输入比"未来"的 buildinfo 旧 → 项目误判 up-to-date → 跳过重查 → 按旧声明报幽灵错或漏报。turbo/eslint(`--cache-strategy content`)/vitest 均按内容 hash，免疫；唯一受害者是 tsgo。tsgo 当时已是 npm 最新 dev 版，升级无解。

**根治（仓库侧，已落地）**：
1. `scripts/dev/ensure-fresh-mtimes.mjs` 入口守卫（**仅 WSL 生效**，检测 `WSL_DISTRO_NAME`/`/proc/version`，其它环境静默跳过零开销）：`pnpm build/typecheck/check/check:full` 前扫描 apps/packages/extensions/extensions-external，未来 mtime 的 `*tsbuildinfo*` **删除**（touch 到 now 反而让它比真实输入更新、误判依旧），其它未来文件 touch 归一（方向安全：只会多查不会漏查）。健康仓库静默，全量扫描约 70ms。
2. `apps/editor/scripts/typecheck.mjs` 自愈重试：typecheck 失败自动删三个 buildinfo（`dist/.tsbuildinfo-node`、`dist/.tsbuildinfo-web`、`integration/tsconfig.tsbuildinfo`）重跑一次，把原手工恢复流程自动化；重试仍败才是真类型错误。

**机器层建议**（守卫命中频繁时做）：确认 Windows 宿主时间正确后 `wsl --shutdown` 重启；WSL 内 `sudo hwclock --systohc` 把校正后的系统时间写回 RTC。RTC 可能再漂移，长期保障靠仓库守卫。

**判别要点**（若再遇疑似缓存问题）：先确认报错文件本次未改动、HEAD 干净态同样报错（`git stash` 验证），再怀疑缓存；跑 `node scripts/dev/ensure-fresh-mtimes.mjs` 看是否命中未来 mtime。
