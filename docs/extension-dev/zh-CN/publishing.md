# 发布扩展

> 把打包好的 `.vsix` 上传到市场，让用户在编辑器的扩展视图里搜到并安装。发布 token 在市场的自助注册页填表即可获得；注册是**审批制**——token 立即可用，但要等管理员批准后才能真正发布。

## 前置条件

- 扩展已经能 `npx uex package` 打包出 vsix 并在编辑器里安装自测通过（见 [快速上手](./getting-started.md) ⑧）
- `package.json` 里 `publisher`、`version`、`engines.universe`、`files` 都已就绪
- 已拿到发布 token 且审批已通过（见下文，自助注册即可获得 token，但发布需等管理员批准）

## 市场地址（registry）

`uex` 需要知道往哪个市场传包。解析顺序如下，任一命中即可：

1. `--registry <url>` 命令行旗标（每个命令都可带）
2. 环境变量 `UNIVERSE_GALLERY_URL`
3. `~/.uex/config.json` 里的 `defaultRegistry`（`uex login` 时会落盘；只登录过一个市场时也会自动用那一条）

没有内置默认地址，三处都不配会直接报错并列出上面三种修法。编辑器用户侧的市场地址由管理员通过 `--gallery-url` 配置，与作者侧无关——用户能不能看到你的扩展，取决于他们的编辑器指向你发布的那个市场。

## 获取 token

**自助注册（推荐）**：浏览器打开 `<市场地址>/gallery/register`，填你的 **publisher 名**（即 `package.json` 里的 `publisher` 字段：小写字母/数字/连字符，最长 64 字符）提交即可。注册成功页面会展示 token 和按该市场地址预拼好的 `uex login` 命令。**token 只显示这一次，请立即保存**——之后服务器只存它的 sha256，丢了查不回来，只能吊销重签。

表单里另有两项可选：**邮箱**（仅落库供运维联系，不公开展示）和 **token 备注（label）**（标记这张 token 的用途/设备，例如 `zhangsan-laptop`、`ci-release-bot`，便于日后吊销；留空默认为 `web-register`）。

**审批制**：自助注册成功后 publisher 处于"待审批"状态——token 立即有效，可以 `uex login`，但 `uex publish` 会返回 403（消息含 `pending approval`），直到管理员在市场管理页批准。审批进度随时可用 `npx uex whoami` 查询（待审批时会显示"待审批"）；批准后无需任何额外操作即可发布。被拒绝则 token 直接失效（whoami 返回 401），可换名重新注册。

**运维签发（备选）**：需要走受控流程时，联系市场运维，报上 publisher 名和 label；运维用 `node scripts/gallery/token.mjs issue --publisher <名> --label <标签>` 签发，明文同样只在签发时打印一次。同一 publisher 下每个有效 token 的 label 必须唯一。运维通道签发的 publisher 直接是已启用状态，无需审批。

**token 即身份**：谁拿着这个 token，谁就能以你的 publisher 名义发布和下架任何扩展。泄露了第一时间找运维 `revoke` 该 label 并重签。责任边界的完整说明见 [安全与信任](./security-and-trust.md)。

## uex login：落盘凭证

```bash
npx uex login acme --registry <市场地址>
```

交互式粘贴 token 后，`uex` 会先调市场的 `whoami` 接口验证 token 归属：token 属于 `acme` 才落盘，属于别人会直接报错（防止把 A 的 token 记到 B 名下）。验证通过后写入 `~/.uex/config.json`，按市场地址分桶存放，第一个登录的市场自动成为 `defaultRegistry`。

注意两点：

- **config.json 里 token 是明文**（与 `~/.vsce` 相同）。共享机器上请改用环境变量。
- **CI 场景不落盘**：直接设环境变量 `UNIVERSE_MARKET_TOKEN`，它的优先级高于 config.json。`uex login` 也支持 `--token <token>` 非交互传入。

## uex publish：打包并上传

```bash
npx uex publish
```

不给 `--package-path` 时，`publish` 会先完整跑一遍打包流水线：校验 manifest → 执行 `universe:prepublish`（模板里是 `npm run build`）→ 检查入口文件存在 → 生成 vsix，然后才上传。已经用 `uex package` 打出过包的，可以 `npx uex publish --package-path <文件.vsix>` 跳过打包直接传。

上传前 `uex` 会读 vsix 里的 manifest 确认 `publisher` 存在；vsix 超过 20 MB 会给出体积警告（服务器有硬上限，见下文）。

发布时服务端会自动计算 vsix 哈希并完成签名（编辑器安装时验签），**作者无需任何签名操作**。发布成功后，用户就能在编辑器的扩展视图里搜到并安装。

## 版本不可变（红线）

**同一个 `<publisher>.<name>@<version>` 只能发布一次**。服务器发现版本号已存在会直接返回 409 拒绝，无例外、无覆盖开关。

这意味着改了任何内容——哪怕只改了一个 README 错别字——都必须 bump `version` 再发。这条规则保证用户装到的 vsix 与版本号一一对应，是供应链安全的地基。版本号语义与 `engines.universe` 的关系见 [API 版本与 `engines.universe`](./versioning.md)。

## 打包内容要求

vsix 的内容是**白名单制**，以下文件进包，其余一律不进：

- `package.json`（必带）
- `files` 数组里列出的每一项（文件或目录）
- `README.md` / `CHANGELOG.md`（存在就总是带上，不必列进 `files`）

由此派生的硬性要求：

- **`files` 必填**。没有 `files` 的扩展会被拒包——这是故意的，把 `.env`、密钥、`node_modules` 挡在包外。模板默认 `"files": ["dist", "icon.png"]`。
- **`publisher` 必填**，且必须等于你 token 的归属 publisher，否则服务器 403。
- **`engines.universe` 只接受有限的范围形式**：`>=X.Y.Z <A.B.C`、`^X.Y.Z`、`~X.Y.Z`、精确版本、`*`。`||` 与连字符范围（`1.2.3 - 2.0.0`）会被拒——宿主对这类声明 fail-closed，原因见 [版本规则](./versioning.md)。
- **`engines.universe` 必须覆盖当前编辑器版本**：`uex package` / `uex publish` 会用 `satisfies` 检查区间是否包含当前编辑器版本，不覆盖则报 error（`engine-coverage`）并阻止打包/发布；故意面向旧编辑器发版时用 `--force` 只把这一条降级为 warning（其余检查不受影响）。

打包前可以用 `npx uex ls` 预览将进包的文件清单，确认没有误带或漏带。

## 市场展示素材：icon / README / 分类

市场在扩展详情页展示的内容全部来自 vsix 本身：

- **`icon`**：`package.json` 的 `icon` 字段指向一张 png（如 `"icon": "icon.png"`），服务器从 vsix 里抽出展示
- **`README.md`**：渲染为详情页正文；**`CHANGELOG.md`**：渲染为更新记录
- **`categories` / `keywords`**：帮助用户在扩展视图里搜索和筛选

## uex unpublish：下架

```bash
npx uex unpublish acme.my-extension@0.2.0   # 下架单个版本
npx uex unpublish acme.my-extension --yes   # 整扩展下架（所有版本）
```

- 带 `@<version>`：只移除该版本，其余版本保留。
- 不带版本：**移除整个扩展的全部版本**。交互终端里会先要求确认；非交互环境必须显式传 `--yes`，否则报错退出。
- 只能下架自己 token 归属 publisher 名下的扩展，动别人的会 403。

下架是**移除**不是标记：registry 里的条目和服务器上的 vsix 资产都会被删掉。已安装的用户不受影响（本地副本还在），但新用户搜不到，已下架的版本号以后可以重新发布（它已不存在，不触发 409）。

## 为什么绕过客户端没用（服务端校验）

`uex` 客户端的校验只是让错误更早暴露，真正的门禁在服务器。每次上传，服务器都会：

1. **亲自解开 vsix** 读 `package.json`，用与宿主同一份 schema 校验——客户端声称什么一概不信，registry 元数据只从服务端解出的 manifest 抽取
2. 校验 manifest 里的 `publisher` **等于 token 的归属 publisher**，不等即 403
3. 检查版本号是否已存在，存在即 **409**（版本不可变）
4. 体积超限即 **413**（流式接收，边传边计，超限中断）
5. 校验 `engines.universe` 的 range 语法——`||` 与连字符范围（`1.2.3 - 2.0.0`）fail-closed 直接拒发，只允许 `>=X.Y.Z <A.B.C`、`^X.Y.Z`、`~X.Y.Z`、精确版本、`*`

所以不用想着手搓请求绕过 `uex` 的检查——服务端会把同一份检查再做一遍。被拒时按报错对照上面的「打包内容要求」逐条核对即可。

## 完全离线的内网场景

如果你的开发环境完全拉不到公网 npm，连开发依赖都装不上：`@universe-editor/extension-api` 等 SDK 包的 tarball 由市场服务器静态托管，可以直接 `npm i https://<市场地址>/gallery/sdk/<包名>-<版本>.tgz` 安装，版本与 npm 上的一致。正常能访问 npm 的环境不需要关心这个。

## 相关阅读

- [快速上手](./getting-started.md) — 从空目录到发布的完整流程
- [API 版本与 `engines.universe`](./versioning.md) — 版本号怎么写、宿主按什么协商加载
- [安全与信任](./security-and-trust.md) — token 即身份、作者责任清单
