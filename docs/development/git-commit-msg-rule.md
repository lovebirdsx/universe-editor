## 提交格式：

```text
<type>(<scope>): <summary>
```

要求：

```text
summary 使用祈使句或简短动词短语
summary 不超过 72 个字符
不要以句号结尾
一个 commit 尽量只做一类事情
用户可见变化优先用 feat/fix/perf/security
内部维护不要滥用 feat/fix
```

## 提交信息前缀

| 前缀       | 用途                             |
| ---------- | -------------------------------- |
| `feat`     | 新功能                           |
| `fix`      | Bug 修复                         |
| `perf`     | 性能优化                         |
| `refactor` | 重构，不改变外部行为             |
| `docs`     | 文档变更                         |
| `style`    | 格式、空格、代码风格，无逻辑变化 |
| `test`     | 测试相关                         |
| `build`    | 构建系统、依赖、打包配置         |
| `ci`       | CI/CD 配置                       |
| `chore`    | 杂项维护                         |
| `revert`   | 回滚提交                         |
| `security` | 安全修复                         |

## scope 示例

```text
feat(auth): add SSO login
fix(billing): correct tax calculation
perf(search): reduce query latency
docs(api): clarify rate limit behavior
```

## 发布说明

发布说明**不由提交信息自动生成**：每个版本的正文是 `docs/release-notes/<version>.md`，由人工（可借助 skill `generate-release-notes`）整理、确认后发版编译（见 [docs/release-notes/README.md](../release-notes/README.md)）。提交信息只是整理事实与追溯变化的线索，因此：

- 写提交信息时不必为「进发布说明」做额外标记；`!` 仍按 conventional commits 惯例用于标识**破坏性变化**，但收录与否由正文作者按用户可见性判断。
- 用户可见的变化不要只写在提交里——必须同步 `docs/user/` 文档（仓库硬约定），并在该版本的正式稿里体现。

## 禁止署名水印

提交信息（含 trailer）不得包含 AI/工具署名水印，例如 `Co-Authored-By: Claude <noreply@anthropic.com>`：提交只描述变更本身。
