# .claude/memory — 跨 clone / 跨机共享的 Claude memory

Claude 的 auto-memory 默认按 **当前工作目录(cwd)的绝对路径编码** 存到全局区
`~/.claude/projects/<cwd编码>/memory/`,不在工作目录里。因此同一个工程的多个
clone、以及不同机器,memory 互不可见。

本目录是 memory 的**真身**并纳入 git。通过 **junction / symlink(目录软链接)** 把
全局区的 memory 目录指向这里,使 Claude 的读写直接落到 repo,从而:

- 本机:所有 clone / worktree 共享同一份 memory(worktree 在 v2.1.63+ 会自动
  重定向回主 clone 的全局 memory 目录,因此 worktree 无需单独链接)。
- 跨机:`git pull` 即同步 memory;`git push` 即上传。纯 git,无需第三方工具。

## 目录约定

- 每条 memory 一个 `*.md` 文件(含 frontmatter),`MEMORY.md` 是索引。
- 这套结构与 Claude 原生 memory 完全一致,Claude 直接读写,无需适配。

## 新机器 / 新 clone 接入

在仓库根目录跑一次(跨平台,Windows junction / posix symlink,均无需管理员权限):

```bash
pnpm memory:link          # 链接当前 clone 的 memory 到本目录
pnpm memory:status        # 只查看状态,不改动
```

脚本(`scripts/link-memory.mjs`)会按 cwd 推算 Claude 全局 memory 目录并建链接。
若目标目录已有本目录中不存在的文件,脚本会拒绝覆盖并列出它们,需先手动合并再重跑。

## 手动建链接(脚本不可用时的兜底)

按 cwd 推算 Claude 全局目录名:盘符保留、`:`/`\`/`/`/`_` 全部替换成 `-`。
例 `D:\git_project\universe-editor` → `D--git-project-universe-editor`。

Windows:
```cmd
rmdir /S /Q "%USERPROFILE%\.claude\projects\D--git-project-universe-editor\memory"
mklink /J "%USERPROFILE%\.claude\projects\D--git-project-universe-editor\memory" "D:\git_project\universe-editor\.claude\memory"
```

macOS / Linux(无盘符,例 `/Users/me/universe-editor` → `-Users-me-universe-editor`):
```sh
rm -rf "$HOME/.claude/projects/-Users-me-universe-editor/memory"
ln -s "/Users/me/universe-editor/.claude/memory" "$HOME/.claude/projects/-Users-me-universe-editor/memory"
```

## 注意

- 链接是**本机文件系统状态**,不随 git 走,每台新机器 / 每个新 clone 需各做一次。
- 跨机若两边同时改 memory,可能产生 git 冲突;memory 多为独立小文件,冲突概率低,
  按普通文本冲突解决即可。
- 不要把 `~/.claude` 整个目录做软链接——Claude 运行中若发现它缺失会重建,会打断链接;
  只链接到 `memory` 子目录这一级。
