# 更新安装慢优化 · 实施计划

> 背景来源：用户反馈"点击更新到完成至少 10 秒以上"，而启动性能日志只显示 `total=1259ms`。经跨进程插桩 + 多轮受控实验，定位真因并落地首批优化。
>
> **核心诊断结论（2026-07-19 重大修正）**：整个"点击更新→新版启动"耗时 ≈ 14.9s，其中 90% 落在旧进程退出 → 新进程创建之间（NSIS 静默安装段）。该黑洞由**两部分**组成：
> 1. **解压+双写本体：仅 ~6s**（353MB 净荷，本机 NVMe + Defender 排除生效时）。耗时随净荷字节数近似线性（实测 ~22ms/MB）。
> 2. **`WM_SETTINGCHANGE` 广播被挂死窗口阻塞：0 ~ 35s+，可变且是波动大头**。`installer.nsh` 用 NSIS `SendMessage /TIMEOUT=5000` 广播 PATH 变更，其底层是 `SMTO_NORMAL`——桌面上**每个**消息泵挂死的顶层窗口都串行吃满 5s 超时。实测一个卡死的 VSCode 更新器进程（7 个挂死窗口）让静默安装从 ~6s 涨到 ~42s。真实更新还要先跑旧卸载器（其 PowerShell `SetEnvironmentVariable` 内部还有一次 SMTO_NORMAL 广播），双倍暴露。
>
> 早前把黑洞全部归因于"NSIS 双写净荷 + Defender 逐文件扫描"是**不完整的**：双写只解释固定的 ~6s 底座；历史 13.4s/11.5s 两次实测的差值与超额部分主要是广播阻塞（当时桌面挂死窗口数不同）。压缩等级、差量更新、盘速的排除结论仍然成立。
>
> 通用纪律：
> - 每个阶段结束跑 `pnpm check`（仅截取错误输出）。
> - 性能验证在打包产物上做：`pnpm package:win` 后用 `/S /D=<临时目录>` 静默解压计时。
> - 提交粒度按阶段，commit 信息遵循 conventional commits。

---

## 诊断历程（已完成，供续接时理解结论怎么来的）

### 计时插桩（已落地，保留）
跨进程停机黑洞无法用 `performance.mark` 跨越（各进程独立 timeOrigin + `will-quit` 同步、FileLogger 150ms debounce 会被进程退出截断）。改用**墙钟 epoch 时间戳 + 同步落盘的 trace 文件**接力：

- `apps/editor/src/main/services/update/updateShutdownTrace.ts`（新增）：`beginShutdownTrace` / `recordShutdownMark` / `readShutdownTrace` / `clearShutdownTrace`。只有安装退出路径 arm，正常退出全 no-op。
- `updateMainService.ts` `quitAndInstall`：打 `click` / `confirmed` / `afterQuitAndInstall`。
- `index.ts`：`before-quit.proceed` / `willQuit.start` / `willQuit.end` 三点；`app.whenReady` 里 `logShutdownTraceIfPresent` 读回上个进程 trace、用 `process.getCreationTime()`（epoch ms，与 `Date.now()` 同基准）算出安装黑洞、记日志、删文件。
- `managedChildProcess.ts` `dispose()`：同步 tree-kill 前后打 `kill.start/end:<label>`。

**这套插桩建议保留**，是后续验证真实更新停机的唯一手段（离线解压计时只能测安装器一段，测不到退出+relaunch 全链）。

### 实测数据（两次真实更新）
```
clickToRelaunch=14905ms / 12106ms
  confirmed→afterQuitAndInstall : ~1s（下载已完成，这是 spawn 安装器）
  三个子进程 kill              : 各 ~150ms（正常，无 tsserver 孤儿卡顿）
  willQuit.end→processCreated  : 13356ms / 11530ms  ← 90%，NSIS 安装黑洞
```

### 被逐一排除的假设（别再走这些弯路）

> 注（2026-07-19）：下表实验当时不知道广播阻塞的存在，绝对秒数普遍含当日桌面挂死窗口造成的广播噪音；但各实验都是同环境相对比较，排除结论本身仍成立。
| 假设 | 实验 | 结论 |
|---|---|---|
| tsserver 孤儿卡退出 | 子进程 kill 各 ~150ms | ❌ 否决 |
| 磁盘慢 | C 盘 NVMe 裸写 352MB = 0.28s（1266MB/s） | ❌ 盘不是瓶颈 |
| Defender 扫安装包 exe | 缓存目录加排除后仅降 1.8s；MsMpEng 新增 CPU=0 | ❌ 非主因 |
| 压缩等级高导致解压慢 | maximum/normal/store 解压都 ~14s | ❌ LZMA 解压速度与压缩等级无关 |
| 不压缩(store)会更快 | 353M store 包解压 36.7s，比 92M 压缩包的 14s **更慢** | ❌ 反而恶化 |
| 差量更新(blockmap)能救 | 差量省的是下载，不在安装这段 | ❌ 方向错 |

### 真因（源码级确认，app-builder-lib@25.1.8 + 本仓 installer.nsh）
1. **NSIS 双写**：`templates/nsis/include/extractAppPackage.nsh` 的 `extractUsing7za` 宏——先解压到 `$PLUGINSDIR\7z-out`（写一遍），再 `CopyFiles` 到 `$INSTDIR`（写第二遍）。353MB 净荷 → ~706MB 写 + 353MB 读 ≈ 1GB IO。设计原因是 PR #6547 的原子性 + 失败可检测保护。**2026-07-19 量化修正：这部分在本机只占 ~6s**（Defender 排除生效时），不是黑洞主体。
2. **解压耗时 ∝ 净荷字节数**（不是压缩流大小）：92M 压缩包 < 353M 存储包，因为两者写盘量都是 353MB，但存储包多读 261MB + 多扫 261MB。压缩用免费的 LZMA 解码换掉了读盘+扫描。斜率实测 ~22ms/MB（353→305MB 省 1.05s，四轮交替稳定复现）。
3. **`WM_SETTINGCHANGE` 广播阻塞（2026-07-19 新发现，波动主因）**：`installer.nsh` 的 `SendMessage ${HWND_BROADCAST} ... /TIMEOUT=5000` 底层是 `SendMessageTimeout(SMTO_NORMAL)`，对每个挂死窗口串行等满 5s。微基准（同参数直接调 API）：桌面有卡死的 `CodeSetup-*.tmp`（VSCode 更新器，7 个挂死窗口）时 SMTO_NORMAL 36.5s vs SMTO_ABORTIFHUNG 1.3s。卸载侧 PowerShell `[Environment]::SetEnvironmentVariable(...,'User')` 内部还有一次 .NET 自带的 SMTO_NORMAL 广播（1s/挂死窗口）。
4. **Defender 逐文件扫描**：本机 Temp/D: 均在排除列表，故上述 ~6s 是"排除生效"的下限；无排除的用户机器解压段会更慢（VSCode 的正解是代码签名信誉，见方向 C）。

### 广播修复的边界（实验记录）
- `SMTO_ABORTIFHUNG` 依赖系统的 hung 标记：对**长期挂死**的真实进程（CodeSetup）有效（1.3s）；但对 `NtSuspendProcess` 刚挂起的进程**无效**（微基准两种 flag 都 ~71s）——hung 标记有滞后。因此修复必须叠加**短超时（1000ms）**兜底：正常窗口处理 WM_SETTINGCHANGE 是毫秒级，1s 不损失任何功能，最坏情况从 5s/窗降到 1s/窗。
- 用 WinForms `Show()` + `Start-Sleep` 人造的"挂起窗口"不会阻塞广播，复现实验需用真实挂死进程或 `NtSuspendProcess`。

### VSCode 对照（`D:/git_project/vscode`，参考）
- **Defender**：VSCode 的 Inno Setup 里**零排除项**，靠 EV 代码签名信誉 + Inno 直接落盘不双写。→ 真正的 Defender 正解是**代码签名**，不是加排除。
- **locale**：VSCode 全量保留 55 个 .pak（面向全球）。我们只面向中英文，删得更狠合理。
- **净荷瘦身**：VSCode 有系统化的 `build/.moduleignore`（删 test/docs/*.ts/*.map + TS 冗余 bundle）+ asar unpack 白名单（减文件数）+ 扩展 esbuild bundling。这是可直接借鉴的核心。

---

## 已落地改动（阶段 1，已验证）

`apps/editor/electron-builder.yml`：
```yaml
electronLanguages:      # 只留应用用到的 locale
  - en-US
  - zh-CN
afterPack: build/afterPack.cjs   # 删框架释放的大文件
```
`apps/editor/build/afterPack.cjs`（新增）：删 `LICENSES.chromium.html`（框架文件，`files: '!'` 管不到，必须 afterPack）。

**验证结果（0.1.46 包）**：
- `locales/` 55 个 → 2 个（41MB → 976KB）
- `LICENSES.chromium.html` 已删（-8.7MB）
- 净荷 353M → **305M**（-48MB）
- 安装包 92.5M → 88.4M

**解压计时（2026-07-19 补齐，管理员 PowerShell，`/S /D=%TEMP%\...`，每轮先删 uninstall 注册表项保证纯安装，四轮交替）**：

| 包 | 净荷 | 第 1 轮 | 第 2 轮 |
|---|---|---|---|
| 0.1.44（瘦身前） | 352MB / 375 文件 | 42.44s | 42.33s |
| 0.1.46（瘦身后） | 304MB / 321 文件 | 41.36s | 41.31s |

绝对值远超历史 ~14s——当时桌面有卡死的 VSCode 更新器（7 个挂死窗口），每轮安装都被 SMTO_NORMAL 广播卡 ~36.5s（微基准单独证实）。**扣除广播后解压本体：base ≈ 5.9s、slim ≈ 4.9s，48MB 省 ~1.05s（~22ms/MB），线性省时结论成立**，但绝对收益比原估的 ~2s 小（本机 Defender 排除生效；无排除机器上斜率更陡、瘦身收益更大）。

---

## 已落地改动（阶段 2，2026-07-19，已验证）

`apps/editor/build/installer.nsh`：安装/卸载两处 PATH 变更广播从 NSIS `SendMessage /TIMEOUT=5000`（SMTO_NORMAL）改为 `System::Call SendMessageTimeout(..., SMTO_ABORTIFHUNG, 1000ms)`；卸载侧 PowerShell 从 `[Environment]::SetEnvironmentVariable`（内部自带 SMTO_NORMAL 广播）改为 `Set-ItemProperty` 直写注册表（不广播，广播统一走我们的 ABORTIFHUNG 调用）。

**验证结果**：广播被卡的环境下静默安装 41.4s → **6.1~7.1s**（净荷 305MB，两轮），PATH 写入语义不变。这是本任务**收益最大的单点修复**：把用户桌面上任意一个卡死进程造成的 5s/窗口 × N 的不可控停机，压到最坏 1s/窗口。

---

## 已落地改动（阶段 3，2026-07-19：更新体验 + Defender 排除面）

**更新改为可见进度安装（降低黑洞期焦虑）**：`updateMainService.ts` 的 `quitAndInstall` 改传 `isSilent=false`——assisted installer 非静默运行，用户在安装期间看到进度页而不是数秒无响应的"黑洞"。全程零点击、装完自动重启，靠以下守卫保证（均以 `--updated` 参数触发的 `${isUpdated}` 判定）：
- license / directory 页：模板自带 `skipPageIfUpdated` 跳过（`common.nsh`）。
- per-user/per-machine 选择页：`installer.nsh` 新增 `customInstallMode` 钩子，按注册表里既有安装的模式强制选择并跳页。
- FINISH 页：`installer.nsh` 新增 `customFinishPage` 钩子，updated 时在 pre 回调直接 `Call StartApp` + `Abort`（安装节仅在 Silent 时自启应用，非静默必须在这里补）；全新安装仍是默认"运行 + 完成"页。
- Defender 询问：原 `IfSilent` 守卫追加 `${isUpdated}` 判定（更新不再静默，单靠 IfSilent 挡不住）。
- 运行中应用：模板 `_CHECK_APP_RUNNING` 在 `isUpdated` 时不弹框、Sleep 后直接 taskkill（与静默一致）；更新链路中的旧卸载器恒以 `/S` 运行，其 `IfSilent` 守卫不受影响。

**Defender 排除面扩大（原方向 D）**：`add/remove-defender-exclusion.ps1` 在安装根之外追加 electron-updater 下载缓存目录（`%LOCALAPPDATA%\<updaterCacheDirName>`，目录名从随包 `resources/app-update.yml` 读取，不硬编码包名）；`installer.nsh` 的询问文案同步提及"更新缓存目录"与更新期扫描的影响。

---

## 待决策的后续方向（按收益/风险排序，2026-07-19 按新归因重估）

### 方向 0：真实更新链路端到端验证（下一步，零改动）
发布 0.1.46 到内网 feed，用保留的 shutdownTrace 插桩实测一次真实"点击更新→新版启动"，验证黑洞从 ~13.4s 降到预期 ~7s（解压 ~5s + 两次 1s 内广播 + 卸载器 PowerShell spawn ~1s）。离线 `/S /D=` 只测安装器一段，测不到"旧卸载器+安装"完整链。

### 方向 A：继续净荷瘦身（低-中风险）
照抄 VSCode `.moduleignore` 思路。**每项都须先确认引用关系再删**（已发现 agent 的通用建议与实际文件不符，如 tsc.js/tsserverlibrary.js 在本仓已是 0 字节占位）。

候选（`.runtime-resources/`，解压后净荷）：
- `typescript-language-server` 26M：大头是 `typescript.js` 8.7M + `_tsc.js` 5.9M。**须确认 typescript 扩展入口只 require `tsserver.js`** 再删冗余；另有 `cli.mjs.map` 1.4M sourcemap（纯可删）、`ru/ja/ko/...diagnosticMessages` 语言包。
- `app.asar` 42M：裁 `**/{test,tests,docs,example,examples}/**`、`**/*.md`、`**/*.ts`、`**/*.map`。
- 收益重估：本机（Defender 排除生效）实测 ~22ms/MB，净荷每削 25MB 仅省 ~0.55s；无排除的用户机器收益更大。优先级降低，作为顺手优化。

### 方向 B：pnpm patch 消除双写（收益重估后大幅降级）
原以为能"砍一半以上"，但双写解压本体只有 ~6s，单写理论上限省 ~2-3s，还要承担 PR #6547 原子性保护丢失 + 每次升级 app-builder-lib 重对 patch 的维护成本。**建议搁置**，除非方向 0 实测后解压段仍是主要痛点。
- ⚠️ **不要用** `useZip:true + differentialPackage:false`：虽然走单写，但丢掉 blockmap 增量更新 → 每次全量下 353MB，对内网分发是负优化。

### 方向 C：代码签名（Defender 正解，独立大工程）
VSCode 靠签名信誉降低 Defender 扫描开销。需 EV 证书 + CI 集成，独立评估。也顺带解决安装器/exe 的 SmartScreen 警告。对无 Defender 排除的用户机器，这是解压段剩余耗时的主要杠杆。

### 方向 D：扩大 Defender 排除面（✅ 已落地，见阶段 3）
更新缓存目录 `%LocalAppData%\<updaterCacheDirName>` 已随首装排除脚本一并加入/移除（目录名读自 app-update.yml）。

---

## 关键文件索引
- `apps/editor/electron-builder.yml` — 打包配置（已改 electronLanguages/afterPack）
- `apps/editor/build/afterPack.cjs` — 删框架大文件钩子（已建）
- `apps/editor/build/installer.nsh` — NSIS customInstall/customUnInstall（已改：广播 SMTO_ABORTIFHUNG+1s、卸载 PATH 直写注册表；含现有 Defender 排除逻辑，IfSilent 跳过）
- `apps/editor/resources/defender/add-defender-exclusion.ps1` — 首装排除脚本（方向 D 改这里）
- `apps/editor/src/main/services/update/updateShutdownTrace.ts` — 跨进程停机 trace（保留）
- 双写源码：`node_modules/.pnpm/app-builder-lib@25.1.8_.../templates/nsis/include/extractAppPackage.nsh`（方向 B patch 目标，已搁置）
- VSCode 参考：`D:/git_project/vscode/build/.moduleignore`、`build/gulpfile.vscode.ts:352-367`（asar unpack 白名单）

## skill 关联
- `nsis-installer-autoupdate` — 安装器/自动更新领域知识全部收敛于此（模板机制速查、零点击守卫链、广播阻塞根因与修复边界、测量方法学）
