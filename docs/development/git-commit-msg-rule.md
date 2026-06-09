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

发布说明只收录带 `!` 标记的提交：

```text
feat!: add SSO login
fix(billing)!: correct tax calculation
build(dev)!: switch to new build tool
```

已知类型（feat/fix/perf/security）展示在对应分组，其它类型展示在"其他变更"。
无 `!` 的提交，无论何种类型，均不出现在发布说明中。
