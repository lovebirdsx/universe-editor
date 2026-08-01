---
'@universe-editor/uex': minor
'@universe-editor/create-extension': minor
---

新增第三方扩展工具链：`@universe-editor/create-extension`（`npm create @universe-editor/extension` 脚手架，basic/webview 两模板）与 `@universe-editor/uex`（CLI：`package`/`ls`/`dev`/`login`/`publish`/`unpublish`）。第三方开发者从起项目到出 VSIX 全程不接触本仓库；`uex publish` 客户端先行，服务端发布通路在 Phase D 联调。
