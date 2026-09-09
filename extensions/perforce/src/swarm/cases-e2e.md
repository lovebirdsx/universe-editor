> 本文从 [CLAUDE.md](CLAUDE.md) 拆出的案例细节：e2e 套路（fake Swarm REST server）+ 必踩坑。坑1「e2e 跑预构建产物」与 `apps/editor/e2e/CLAUDE.md` 重复（ensure-e2e-build 已自动兜底），直接删不迁。红线结论见主文档。

### e2e 套路（fake Swarm REST server）

本机 / CI 无真 Swarm 服务器，用纯 Node fake server 端到端跑：

- `extensions/perforce/e2e/fixtures/fake-swarm.mjs`——依赖 free 的 `node:http` server，内存审核模型 `{1001:{…}}`，把 baseUrl 写进 `UNIVERSE_SWARM_FAKE_PORTFILE`，请求逐行记进 `UNIVERSE_SWARM_FAKE_LOG`。**认证无条件放行**（凭据链路由单测覆盖）。改端点在这里加 case。
- `extensions/perforce/e2e/fixtures/swarmApp.ts`——Playwright fixture：拉起 fake-swarm + fake-p4，seed 配置（`swarm.enabled/url/apiVersion`），暴露 `swarm.requests()` / `swarm.waitForRequest()`。
- `extensions/perforce/e2e/fixtures/fake-p4.mjs`——`login` case 在 `-p` 时打印假 ticket。
- `extensions/perforce/e2e/specs/swarmReview.spec.ts`（`@p1`）——开 view → 载 dashboard → 开审核 → vote → transition → 断言 fake server 记录到的请求 body。

#### e2e 必踩的坑（坑1「e2e 跑预构建产物」与 apps/editor/e2e/CLAUDE.md 重复，已删）

2. **`runCommand('swarm.openReviews')` 冷启动会 race `ViewsService.reconcileFromStorage`**：命令刚设的 active 容器被 storage 恢复覆盖 → view 不渲染。e2e **点 Activity Bar 项**（`[data-testid="activitybar-item-workbench.view.swarm"]`）打开，这才是健壮的用户路径。
3. **命令激活 race + 按钮文案匹配**：
   - 视图首次 mount 时扩展宿主命令可能**尚未注册**，`executeCommand` 返回 `undefined`。`SwarmReviewsView` 的 `load()` 遇 `undefined` **重试（250ms 退避，最多 20 次）**而非缓存空 dashboard——否则列表永远空。
   - 按钮内含图标 span（如 `↑Vote Up`），`getByText('Vote Up',{exact:true})` **匹配不到**；用 `getByRole('button',{name:'Vote Up'})`。
4. **别在 `expect.poll` 的驱动循环里断言尚未渲染的 locator**：`locator.textContent()` 会自动等待元素出现，把 poll 的第一轮卡死在自己的超时上（轮询还没成功、元素还不存在的死锁）。先沿用"快速 probe（如 `getSwarmNotifyDiag().lastActionable`）驱动轮询直到成功"，再用 `await expect(badge).toHaveText(...)` 断言。
