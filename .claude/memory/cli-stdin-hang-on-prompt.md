---
name: cli-stdin-hang-on-prompt
description: spawn 外部 CLI 时不关 stdin，命令在需要输入时永久挂起
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8761d741-d79a-4e7c-9b58-6fe88cc948ff
---

spawn 交互型 CLI（p4/git/npm…）时，若不显式处理 stdin，命令在**需要输入**时会永久挂起——没有输入途径就卡死；就算传空 stdin 兜底，也只是把挂起变成快速失败（拿不到想要的东西）。真正的解法是**换一个只读的命令**。

**Why:** Swarm 认证起初用 `p4 login -p` 读 ticket——**理解错了**：`login -p` 不是"读现有 ticket"，而是"**重新认证**并打印新 ticket"，安全服务器会要密码。传空 stdin 后不再挂起，但变成 `EOF reading terminal` 快速失败，ticket 仍拿不到→反复弹"请登录"（用户已登录却被要求再登录）。正解=`p4 tickets`：**只读 P4TICKETS 文件里已有的 ticket，从不重新认证、从不弹密码**，按 user 大小写不敏感匹配（行格式 `server (user) TICKET`）。

**How to apply:**
- 优先用**纯只读**命令：查状态用 `p4 login -s`（只报状态不认证），读已存凭据用 `p4 tickets`（只读文件）。别用名字带 login 的命令去"读"。
- 分清 CLI 动词语义：`login -p`=重新登录，`login -s`=查状态，`tickets`=读缓存。名字像"读"未必是读。
- 传空 stdin（`{ input: '' }`）只能防挂起，不能替代选对命令。

