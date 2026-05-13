**快速上手**

```bash
# 首次安装
pnpm install

# 启动开发（先构建依赖包，再启动 dev 服务器）
pnpm --filter @acme/api dev     # http://localhost:3001
pnpm --filter @acme/web dev     # http://localhost:3000

# 全量构建
pnpm build

# 检查
pnpm typecheck  # 全量类型检查
pnpm lint       # 检查代码规范（含 Prettier 格式）
pnpm lint:fix   # 自动修复代码规范 + 格式问题

# 测试
pnpm test
pnpm --filter @acme/ui test
pnpm --filter @acme/api test
pnpm --filter @acme/web test

# 发布新版本（Changesets）
pnpm changeset          # 声明变更
pnpm version-packages   # 更新版本号
pnpm publish-packages   # 发布
```

**关键架构文件**

| 文件                | 作用                                     |
| ------------------- | ---------------------------------------- |
| pnpm-workspace.yaml | workspace glob + catalog 版本统一管理    |
| turbo.json          | 任务依赖图 + 缓存配置                    |
| tsconfig.json       | Solution file（引用 shared + ui）        |
| config-ts           | 共享 TS 预设（base / react / node）      |
| config-eslint       | 共享 ESLint flat config                  |
| shared              | 纯工具函数，`composite` + `declaration`  |
| ui                  | React 组件库，引用 shared                |
| web                 | Vite + React，`noEmit`，引用 shared + ui |
| api                 | Hono + Node，`NodeNext`，引用 shared     |
