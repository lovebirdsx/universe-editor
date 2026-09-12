---
name: remote-windows-ssh-support
description: SSH 连接 Windows 远程主机全链路支持:平台探测/cmd 命令族/install.js 独立 entry/WMI 逃逸 sshd job kill
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-21T16:12:56.336Z
---

Windows SSH 远程主机支持(2026-08,接续 [[remote-dev-v2-full-stack]]):

- **平台探测状态机**(remoteDeploy.ts `_ensurePlatform`,per-authority 缓存):先 `uname -sm`(MINGW/MSYS/CYGWIN→windows,Linux/Darwin→posix),失败再 `cmd /c "echo UNIVERSE_REMOTE_OS=%OS%.%PROCESSOR_ARCHITECTURE%"`(cmd/powershell 默认 shell 均可执行);AMD64→x64、ARM64→arm64。
- **三 shell → 两 shell(review 修正)**:Windows sshd 默认 shell 只支持 cmd/PowerShell 5.1,**git-bash/MSYS 显式拒绝**——MSYS runtime 在 bash spawn cmd.exe 时把 `/d /s /c` argv 重写成盘符路径(`D:/ S:/ C:/`),cmd 进交互模式静默挂死;`//d` 转义只有 bash 认、cmd/PS 外层不接受,无单一写法通吃(vscode remote-ssh 同此限制)。探测到 uname=MINGW/MSYS/CYGWIN 即抛错引导改 DefaultShell。所有远端命令统一 `cmd /d /s /c "<body>"`,body 内**禁双引号、禁 $、禁反引号**(PS 双引号内展开 $ 和反引号),**body 行首必须 `cd /d %USERPROFILE%&`**——Win32-OpenSSH 对 admin 用户会话初始 cwd 是 System32 而非 home(本机非 admin 无法复现,防御性必做);PATH 前缀用 %USERPROFILE% 勿用 %CD%(cmd 整行一次性展开,cd 生效前 %CD% 是旧值);路径保持相对(绝对路径遇含空格 profile 会撞禁双引号契约)。有逐字快照测试守护(remoteDeploy.test.ts)。
- **受管 node**:win 用 nodejs.org zip + 远端系统自带 `%SystemRoot%\System32\tar.exe`(bsdtar 支持 zip);Windows node 包无 bin/ 子目录。
- **鸡生蛋根治**:esbuild ESM bundle 把 external 原生包提升为顶层静态 import → bootstrap.js 没有 node_modules 时连 `install` 子命令都跑不起来。修法=install 拆成**独立零 external entry**(install.ts+installCli.ts),deploy 命令跑 `node <dir>\install.js`;node-services 加 `"sideEffects": false` 才能摇掉未用的 native import。
- **sshd job kill(头号坑)**:Windows OpenSSH 把会话包进 kill-on-close job object,ssh 会话结束 TerminateJobObject 连 detached 子进程一起杀(node 的 `detached:true` 只是 DETACHED_PROCESS,传不了 CREATE_BREAKAWAY_FROM_JOB——vscode 的 rust CLI 可以)。修法=startDaemon win32 用 powershell `Invoke-CimMethod Win32_Process Create`(-EncodedCommand 避免引号地狱),由 WmiPrvSE 服务代启、天然在 job 外;实机验证父进程=WmiPrvSE.exe、会话结束后存活。无 shutdown 日志 + server.json 残留 = 被硬杀的指纹。**已知限制**:WMI 创建的进程环境是注册表重新生成的默认环境(实测 USERPROFILE/USERNAME 正确,但用户会话动态注入的 PATH 项丢失、嵌套 REG_EXPAND_SZ 如 %NVM_HOME% 不展开)——daemon 核心自包含(fork 全走绝对路径)不受影响,远端 pty 里"找不到用户工具"先想到这里。
- **daemon 可见控制台窗口(2026-09 续修 3e545ed2)**:WmiPrvSE 无控制台,startup info 不带 flags 时 Windows 就给 daemon 新分配一个**可见**控制台窗口(跑测试时桌面多一个终端,daemon 成孤儿则窗口一直留着)。必须用 `CreateFlags = DETACHED_PROCESS(0x8)`——**`CREATE_NO_WINDOW(0x08000000)` 不是合法的 CreateFlags 取值**,Create 返回 21(Invalid parameter)后旧代码静默回退到不带 startup info 的调用,于是每次带窗口且一声不吭(这就是 3e545ed2 修了等于没修的原因);`ShowWindow=0` 也不行,只隐藏进程仍持有的控制台。startup info 是 **EmbeddedInstance**,从类对象造:`[ciminstance]::new((Get-CimClass 'Win32_ProcessStartup'))`(裸类名 `New-CimInstance -ClientOnly` 只有 1/14 个属性,实测两者都能被采纳,但类对象带全 schema 更稳)。**诊断要把"有控制台"和"有窗口"分开**:有 `conhost.exe` 子进程 ⇔ **持有控制台**(`Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid> AND Name='conhost.exe'"`),但**持有控制台 ≠ 桌面上有窗口**——`windowsHide`(CREATE_NO_WINDOW)照样造 conhost 却无窗口,实测 node 从无控制台父进程 spawn 时带不带 windowsHide 都**不**产生可见窗口,只有"WMI Create 不带 startup info"这一条路会造出可见控制台。所以测试锁的是更强的"无控制台"(daemon pid 的 conhost 子进程须为空),**判"弹不弹窗"的终判只能靠 EnumWindows 枚举可见顶层窗口**(实测全量跑完新增=0)。所有降级路径都必须打 `ue:wmi-*` stderr 标记,否则降级无法察觉。
- **POSIX/Windows 安装逻辑单一真相**:deploy 两条路径(POSIX sh body / Windows cmd body)都收敛到 `node <dir>/install.js --bundle-hash <hash>`,vendor 名单/npm 参数/bundle.hash 语义只在 install.ts 一份;POSIX 已在 WSL 实机验证。
- **远端 Windows 路径展示(2026-08-22)**:`remote-ssh` 工作区的 `URI.path` 是规范形态 `/E:/workspace/foo`(前导斜杠+正斜杠),任何**直接渲染给用户**的地方都必须过 `toDisplayPath`(platform `base/path.ts`,`/e:/a/b`→`E:\a\b`,POSIX 路径恒等)——纯形态推断(与 `URI.fsPath` 的盘符检测同源),**不需要远端 OS**,所以对未连接的 recent 记录也有效,不必引 `RemoteEnvironmentDto.os` 做异步查询。远端 URI 上 `.fsPath` 只剥前导斜杠不转反斜杠(得 `E:/a/b`),对远端一律用 `toDisplayPath(uri.path)` 而非 `fsPath`(后者还会折进 authority 语义)。已收口:标题栏左右段/原生窗口标题/Welcome 最近打开/Remote Explorer recent description/agent @mention/tab tooltip(remote scheme 此前落到整条 URI)。仍按 `fsPath` 走的是功能性复制(Search 的 Copy Path、终端拖放粘贴),正斜杠在 cmd/PowerShell 可用,刻意未改。

- **npm 11.17 allow-scripts 虚惊**:node 24 自带 npm 默认跳过未审批 install scripts 并告警,但 ripgrep 1.18/parcel-watcher/node-pty 的二进制全走 optionalDependencies prebuilt,无必须执行的脚本——不用放行。ripgrep 1.18 布局已变:`@vscode/ripgrep-<platform>-<arch>/bin/rg`,老路径 `@vscode/ripgrep/bin/` 不存在,别误判缺失。
