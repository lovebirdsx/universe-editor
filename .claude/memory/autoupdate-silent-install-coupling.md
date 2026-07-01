---
name: autoupdate-silent-install-coupling
description: 自动更新静默安装依赖 quitAndInstall 传 isSilent=true，否则弹目录选择+Defender 提示
metadata: 
  node_type: memory
  type: project
  originSessionId: a6a0360b-16e3-485e-884e-54c48b5b0b0c
---

自动更新时若弹出"选择安装目录"向导 + "Windows Defender 排除"提示，根因是 `updateMainService.quitAndInstall()` 传给 electron-updater 的 `isSilent` 参数。

三方耦合链（改任一处都可能回归此 bug）：
1. `apps/editor/src/main/services/update/updateMainService.ts` → 必须 `autoUpdater.quitAndInstall(true, true)`（isSilent=true）
2. electron-updater `NsisUpdater.doInstall`：`isSilent` 决定是否给 NSIS 加 `/S`。无 `/S` 时因 `electron-builder.yml` 的 `allowToChangeInstallationDirectory: true` 弹目录向导
3. `apps/editor/build/installer.nsh`：`customInstall`/`customUnInstall` 用 `IfSilent` 守卫跳过 Defender 排除的 UAC MessageBox。非 silent 运行时守卫失效 → 弹提示

设计意图（见 installer.nsh 注释）：autoUpdater 静默重装回同一 INSTDIR，首次安装加的 Defender 排除是**按路径注册**的、更新时依然有效，所以更新过程无需也不应再弹这些提示。`--force-run` 负责装完自动重启。
