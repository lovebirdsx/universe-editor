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

| 前缀       | 用途                             | 是否通常进发布说明 |
| ---------- | -------------------------------- | ------------------ |
| `feat`     | 新功能                           | 是                 |
| `fix`      | Bug 修复                         | 是                 |
| `perf`     | 性能优化                         | 是                 |
| `refactor` | 重构，不改变外部行为             | 可选               |
| `docs`     | 文档变更                         | 可选               |
| `style`    | 格式、空格、代码风格，无逻辑变化 | 通常否             |
| `test`     | 测试相关                         | 通常否             |
| `build`    | 构建系统、依赖、打包配置         | 可选               |
| `ci`       | CI/CD 配置                       | 通常否             |
| `chore`    | 杂项维护                         | 通常否             |
| `revert`   | 回滚提交                         | 是/可选            |
| `security` | 安全修复                         | 是，建议高优先级   |

## scope 示例

```text
feat(auth): add SSO login
fix(billing): correct tax calculation
perf(search): reduce query latency
docs(api): clarify rate limit behavior
```

## 发布说明

发布说明只默认展示：

```text
feat, fix, perf, security
```

其它类型的提交如果需要展示在发布说明中，可以在提交信息中添加 `!` 标记：

```text
refactor(system)!: update dependencies
```
