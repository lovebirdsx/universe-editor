# 后台常驻（backgroundMode）

托盘常驻 + 关窗隐藏 + 空闲回收 + 登录自启。只改变窗口生命周期，不新增 daemon、不改手机协议。

## 职责边界

- `backgroundModePolicy.ts`：纯决策（全单测）。后台模式 = 网关启用（`enabled` 或
  `UNIVERSE_MOBILE_GATEWAY=1`）且 `keepRunningInBackground`；`supportsLoginItem` = 打包版、非 E2E、
  win32/darwin。阈值固定：回收 10 分钟、扫描 30 秒（构造器留 seam）。
- `backgroundModeMainService.ts`：托盘、配置订阅、空闲扫描、登录项对齐。**不直接操作 BrowserWindow**，
  只经 `BackgroundModeWindows` 窄接口；窗口服务经 `{ isActive, shouldHideOnClose }` 闭包读它。
- 托盘仅在 `isActive()` 为真时存在；生产托盘创建失败（Tray 抛错或图标 `isEmpty()`）使 `isActive()`
  为假并回退正常关窗，绝不留「无窗口又无托盘」的隐形进程。E2E 放行

## 关窗拦截顺序（红线）

`windowMainService` 的 `close` 事件必须按序判断：

1. `_allowClose`（已确认关闭 / 退出）→ 放行；
2. `_quitConfirmation` 进行中 → `preventDefault`；
3. `!_quitting && shouldHideOnClose()` → `preventDefault` + `hideWindow`，**不跑 renderer veto**；
4. 原 renderer shutdown veto。

隐藏不销毁窗口，renderer / ACP 会话 / 网关继续运行；后台模式且未确认退出时 `window-all-closed`
不 `quit()`（空闲回收关掉最后一个窗口也必须存活）。

## 隐藏窗口持久化与空闲回收

- 经 `planSessionPersist`：有可见窗口只存可见窗口；全隐藏只留 `hiddenSeq` 最大的一个，不恢复一串
  用户主动关掉的窗口。
- 回收需同时满足 hidden、`running === 0`、`ask === 0`、无手机会话订阅；任一破坏即重置计时。
  系统 resume 清空计时。
- 停用后台模式：先 `revealAllHiddenWindows()` 再销毁托盘；若已无窗口则创建主窗口。

## 退出确认前临时显示

`confirmQuit` 先 `reveal()` requester 与「有运行中会话 / 即将成为 requester」
的隐藏窗口，让确认框有可见父窗口；窗口**不移出 `_hiddenSeq`**，veto 后重新 hide，持久化仍按隐藏处理。

## 托盘与登录项

- 托盘图标必须在 **asar 外**：`runtime-resources.mjs` stage `public/icon.ico → resources/tray/icon.ico`；
  dev 读 `apps/editor/public/icon.ico`。macOS/Linux 从 ICO 抽 256px PNG 再 resize。
- 三开关齐备才注册登录项：`launchAtLogin` && `keepRunningInBackground` && 网关启用。Windows
  `setLoginItemSettings({ args: ['--background'] })`（`args` 仅 Windows 生效）；macOS 不传 args，
  用 `getLoginItemSettings().wasOpenedAtLogin` 判定登录启动。
- 托盘还承载两条一次性提示：更新下载完成且无可见窗口时每个版本提示一次，菜单出现「重启以安装更新」；
  用户首次点 X 隐藏时按 `backgroundMode.hiddenNoticeShown` 全局只弹一次。Windows 用
  `Tray.displayBalloon`，否则回退 Electron `Notification`（E2E 只写标记不弹）。

## E2E

`globalThis.__E2E_MAIN__.backgroundMode`（`isActive` / `show` / `exit` / `hiddenWindowIds`）在
`index.ts` 安装，无窗口时也可用 `electronApp.evaluate` 断言。用例见
`apps/editor/e2e/specs/mobile.backgroundMode.spec.ts`（@p1）。
