# tsgo 增量缓存过期导致幽灵 typecheck 报错

**现象**：`pnpm check` / `pnpm typecheck` 报出与本次改动完全无关的 TS2339/TS2305（如 `ManagedChildProcess` 缺成员、`e2e-contract` 缺导出），但对应上游包源码和 `dist/*.d.ts` 明明都是对的；`pnpm build` 全绿也修不好。

**根因**：`tsgo --build` 的增量状态（`apps/editor/dist/.tsbuildinfo-node`、`.tsbuildinfo-web`、`integration/tsconfig.tsbuildinfo`）在 worktree 中过期，没感知到 workspace 包的 `dist/*.d.ts` 已更新，继续按旧声明报错。

**处理**：删掉这些 tsbuildinfo 后重跑即可：

```bash
rm -f apps/editor/dist/.tsbuildinfo-node apps/editor/dist/.tsbuildinfo-web apps/editor/integration/tsconfig.tsbuildinfo
```

**判别要点**：先确认报错文件本次未改动、HEAD 干净态同样报错（`git stash` 验证），再怀疑缓存，不要顺着报错去改源码。
