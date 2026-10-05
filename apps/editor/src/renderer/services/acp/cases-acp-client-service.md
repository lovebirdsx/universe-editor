# cases-acp-client-service.md

本文从 `services/acp/CLAUDE.md` 拆出，范围只有一个：`acpClientService.ts` 的**编辑操作坑**——它是仓库里少数含裸 NUL 字节的源文件。

## 事实：连接池键用 NUL 分隔，**这是设计不是事故**

```ts
private _poolKey(agentId: string, cwd: string, authority: string): string {
  if (!authority && !cwd) return `${agentId}<NUL>`
  const scope = authority ? `remote:${authority}` : ''
  if (!cwd) return `${agentId}<NUL>${scope}`
  return `${agentId}<NUL>${scope}<NUL>${this._uriIdentity.getPathComparisonKey(cwd)}`
}
```

（`acpClientService.ts:500-506`；上面写 `<NUL>` 是展示用，源文件里是**字面 0x00 字节**。）

分隔符刻意选 NUL：`agentId` / `authority` / cwd 三者都不可能含 NUL，拼接后不可能歧义；换成 `:` 或 `|` 都不行——Windows 盘符路径含 `:`，scope 串也含 `:`。改动分隔符等于**连接池键全变**（同一 agent+cwd 会重新 spawn 一个进程）。

## 后果与改法

- 该文件因此是**二进制**：`file` 报 `data`；Grep 默认按 binary 跳过（要搜得加 `-a`）；Read 能读但 NUL 的呈现与磁盘字节不一致。
- **Edit 工具对含 NUL 行的精确匹配不可靠**（读回来的文本与磁盘字节对不上，匹配失败或回写丢字节）。要动这些行用 `sed` 按 **ASCII 子串**替换：匹配串取 NUL 两侧的 ASCII 片段（如 `s/!cwd) return \`\${agentId}/.../` 里的 `!cwd) return`），**别试图把 NUL 写进匹配串**；也别把整行塞进 shell 变量再拼（命令替换 `$(...)` 会在 NUL 处截断）。
- 改动前先 `file` 确认，改完 `file` 仍应是 `data`（若变成 ASCII text，说明 NUL 被你的工具吃掉了——键语义已经变了）。
- 想"顺手统一"这条分隔符前先读上一节：这是连接池键的设计，不是漏改的硬编码。
