# cases-trash.md

本文从 CLAUDE.md 拆出，范围是 explorer 删除操作的回收站（useTrash）决策链路与失败回退的完整论证。

## useTrash 不是纯配置开关

`delete(targets, useTrash)` → `IFileService.delete(uri, {recursive, useTrash})`；main 侧 `shell.trashItem`。

`DeleteFileAction` 算的是 `files.enableTrash（默认 true） && provider 支持回收站`，后者经 `IFileService.getCapabilities(resource).supportsTrash` 查（能力位定义在 `platform/src/files/fileSystemProvider.ts`，对标 VSCode 的 `FileSystemProviderCapabilities.Trash`）。

## 远端（WSL/SSH）恒 false 的完整论证

- 本地 `file:` provider 注入了 `shell.trashItem` 故为 true。
- **远端恒 false**：远端 server 是 headless node，没有 shell 回收站 API，`RemoteFileSystemProvider._capabilities` 直接硬编码 false（不走握手，故未 bump 协议）。远端因此自然走确认框的「永久删除」分支文案。
- **别退回无条件 `useTrash: true`**：那会让远端 provider 抛 `trash is not supported on this filesystem`、文件删不掉（已修，勿回退）。
- 混选（本地+远端）时整批降级为永久删除，不半兑现承诺。
- 同一判定也在 `fileBulkEditService`（扩展 `workspace.applyEdit` 删文件）里做，它无 UI 可问故静默降级。

## 本地 trash 失败的事后回退

本地 trash 真的失败时弹框提供「永久删除」重试，重试前用 `exists` 过滤掉已删项（逐项 delete 会中断，原样重试会 ENOENT）。

## 能力探测失败时保留 useTrash

**能力探测本身失败（如远端断连）时保留 `useTrash`**——探测失败等于「不知道」，答「没有回收站」会把用户要的「移到回收站」静默变成永久删除；让 provider fail loud，再由回退弹框请用户明确决定。

## URI.fsPath 斜杠方向（path.normalize）

**本仓库 URI.fsPath 是正斜杠**（移植省了 Windows `\` 转换），`shell.trashItem` 走 Windows Shell API 要反斜杠，故 node provider 回收站分支已 `path.normalize(uri.fsPath)`——别退回直接传 fsPath（会 "Failed to parse path"）。
