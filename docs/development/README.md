# 开发者文档

面向本仓库开发者与部署方的文档索引。用户向的使用说明在 [`docs/user/`](../user/zh-CN/index.md)。

## 构建与发布

- [发布外部扩展](publishing-extensions.md) — `pnpm ext:release` 把 `extensions-external/*` 自动打包成 `.vsix` 并发布进市场（自动发现、增量跳过）。
- [配置扩展市场服务器](marketplace-server.md) — 自建市场后端：`/extensionquery` 协议、registry 格式、部署与联调。

App 本体的发布（版本 bump、打包、上传）见 [`scripts/release/README.md`](../../scripts/release/README.md)；市场运维脚本细节见 [`scripts/gallery/README.md`](../../scripts/gallery/README.md)。

## 约定与协作

- [Git 提交信息规范](git-commit-msg-rule.md) — 提交格式、类型前缀、发布说明收录规则。

## 环境与工具（个人笔记）

- [开发加速方案](lag-detect.md) — Windows 下排除 Defender / 关闭索引服务，减少 `pnpm dev`/`e2e` 的磁盘抖动。
- [Claude 使用注意事项](claude.md) — 上下文压缩窗口配置。
