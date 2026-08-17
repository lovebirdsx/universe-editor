# Universe Editor 扩展开发

> 面向第三方扩展作者的开发文档：从一个空目录到一个上架市场的扩展，全部内容都在这里。当前以 **API 0.12.0** 为准（0.x 阶段 minor 版本可能携带破坏性变更，务必阅读 [API 版本与 `engines.universe`](./versioning.md)）。

## 开发者旅程

```
npm create @universe-editor/extension   # ① 起项目：生成扩展骨架（esbuild + launch.json）
        │
        ▼
npm install && npm run watch            # ② 装依赖（API 包来自公开 npm）+ watch 编译
        │
        ▼
npx uex dev --inspect=9229              # ③ 拉起扩展开发宿主：直接加载本目录的扩展
        │                                #    VSCode 里 F5 attach，断点命中扩展宿主进程
        ▼
改代码 → watch 重编 → 宿主自动重启          # ④ 迭代循环（autoRestartOnChange 可关）
        │
        ▼
npx uex package                          # ⑤ 产出 <publisher>.<name>-<version>.vsix
        │
        ▼
编辑器里「从 VSIX 安装」自测               # ⑥ 真实安装路径验证
        │
        ▼
npx uex login → npx uex publish          # ⑦ 发布到市场，其他用户搜索即得
```

从零开始跟着做一遍：[快速上手](./getting-started.md)。想看一个已经走通全流程的最小项目：仓库里的 [`samples/hello-world`](../../../samples/hello-world/README.md) 就是脚手架产物加少量注释，可以单拎出来 `npm install` 直接用。

想看各能力的可抄写示例：与主仓库同级的独立仓库 `universe-editor-extension-samples`（暂无远程 URL）汇集 19 个示例，覆盖命令/状态栏/通知/进度/QuickInput/配置/文档编辑/补全/CodeLens/Code Action/装饰/语义高亮/诊断/树视图/Webview/自定义编辑器，每个示例带 e2e 冒烟验证。

## 文档地图

| 主题 | 文档 | 什么时候读 |
|---|---|---|
| 起步 | [快速上手](./getting-started.md) | 第一次开发扩展，从 create 到 publish 全程实操 |
| 结构 | [扩展的结构](./extension-anatomy.md) | 想知道 package.json 每个字段的含义、激活生命周期 |
| 贡献点 | [贡献点参考](./contribution-points.md) | 往命令面板/菜单/快捷键/设置里加东西 |
| API | [API 概览](./api/README.md) | 查宿主提供哪些能力（逐方法细节看编辑器里的类型提示） |
| 调试 | [调试扩展](./debugging.md) | 断点不命中、要看日志、attach 配置 |
| Webview | [自定义编辑器与 Webview](./webview-guide.md) | 做 PDF 预览这类自定义界面 |
| 语言特性 | [语言特性](./language-guide.md) | 做补全/跳转/诊断这类语言支持 |
| 版本 | [API 版本与 `engines.universe`](./versioning.md) | 填 `engines.universe` 前**必读** |
| 发布 | [发布扩展](./publishing.md) | 申请 token、上传市场、下架 |
| 移植 | [从 VSCode 移植](./migration-from-vscode.md) | 已有 VSCode 扩展想搬过来 |
| 安全 | [安全与信任](./security-and-trust.md) | 了解扩展的权限边界与作者责任（红线，必读） |

## 如实说明

本套文档只写宿主**当前真实支持**的能力——贡献点清单以宿主的贡献点翻译器为准，API 清单以 `@universe-editor/extension-api` 的类型定义为准，激活事件以 `COMPATIBILITY.md` 的清单为准。每个清单都标注了对应的 API 版本；宿主没有的能力（terminal、tasks 等）不会出现在这些清单里，移植场景请看[从 VSCode 移植](./migration-from-vscode.md)的缺失对照表。
