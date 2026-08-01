# 05 · 安全模型与信任

> 决策：**MVP 维持现状（软隔离）**，硬隔离/签名后置。
> 本文的核心态度：**如实告知边界，不制造"已沙箱"的错觉**。这与项目既有的"诚实边界"原则一致（fs 网关是文本级边界，Node 权限模型默认关）。

## 1. 现状：软隔离的真实边界

必须先讲清楚 MVP 阶段外部扩展**实际能做什么**：

| 维度 | 现状 | 含义 |
|---|---|---|
| 进程隔离 | ✅ 独立子进程（restricted host） | 扩展崩溃不拖垮主程序；有界重启 |
| 文件访问 | ⚠️ 走 main 网关，但网关是**文本级边界** | 网关转发 fs 调用，不是内核级沙箱 |
| Node 能力 | ⚠️ 权限模型**默认关** | 扩展代码能 `require` 任意内置模块、发网络请求、起子进程 |
| 密钥 | ✅ 绝不进 renderer/host | API key 只在 main 的 `ISecretStorageService`（safeStorage），扩展拿不到 |

**一句话**：MVP 阶段，**安装一个扩展 ≈ 在你机器上运行一段有相当 Node 能力的第三方代码**。这不是 bug，是 MVP 的显式取舍（与 VSCode 早期、以及绝大多数桌面编辑器扩展模型相同——VSCode 扩展至今也能跑任意 Node 代码）。

## 2. MVP 的防护：靠"社会工程层"而非"技术沙箱"

既然技术隔离是软的，MVP 的防护重心放在**降低用户装到恶意扩展的概率**和**如实告知风险**：

### 2.1 发布者信任提示

首次安装某个 publisher 的扩展时，弹确认对话框：

```
即将安装 "Python"（发布者：ms-python）

扩展会以接近本机程序的权限运行，可访问文件、网络。
仅安装你信任的发布者的扩展。

[ 取消 ]  [ 我信任 ms-python，安装 ]
```

- 记住"已信任的 publisher"，同发布者后续不再弹。
- 对标 VSCode 的"发布者信任"心智，但我们**措辞更直白**（因为我们没有 VSCode 的验证发布者体系）。

### 2.2 恶意/弃用清单（control manifest）

见 [02 文档 §6](./02-gallery-protocol.md)。安装前查询：

```
installVSIX 前:
  if (controlManifest.malicious.includes(id)) → 拒装，提示"该扩展已被标记为恶意"
  if (controlManifest.deprecated[id])          → 告警 + 提示迁移目标
启动时:
  已装扩展命中 malicious → 自动禁用 + 通知用户
```

这是**唯一能"事后止血"的机制**——扩展装了之后发现是恶意的，靠清单远程禁用。优先级应较高（Phase B 就做）。

### 2.3 安装一致性校验（防投毒）

见 [01 文档 §5](./01-packaging-and-manifest.md)。核心：VSIX 内的 `publisher.name.version` 必须与市场元数据一致；zip 解压做路径穿越防护（zip-slip）。这防的是"传输/打包环节被替换"，不防"发布者本身恶意"。

## 3. UI 与文档的诚实义务

**这是本文最重要的一条**：不能让用户以为扩展是被沙箱隔离的。

- 详情页/安装确认里，**明确写出**"扩展以接近本机权限运行"。
- 用户文档（`docs/user/`）的扩展章节要有安全提示段落。
- **不要**用"沙箱""隔离运行""安全沙盒"等暗示强隔离的措辞。
- restricted host 这个名字是内部实现名，对用户不宣称它是安全边界。

> 这与代码库现有注释的态度一致——把 fs 网关称为"honest boundary"（诚实边界）而非"sandbox"。市场放大了触达用户的范围，这条纪律更要守住。

## 4. 硬隔离与能力声明（决策：不做）

2026-08 决策更新：**Node 权限模型与能力声明 manifest 均不做**——2026-07 单 host + Workspace Trust 重构后，隔离架构已由用户另行拍板调整；能力声明失去运行时强制对象后只剩告知价值，一并取消。原登记的四条未来路线（权限模型 / 签名 / 能力声明 / Web Worker host）中，**只有 VSIX 签名验证落地**（见 §4.1）；Web Worker / WASM host 如未来重提，另行立项。

**演进策略（历史结论）**：曾评估"能力声明 + 权限模型是性价比最高的下一步"；该评估基于双 host 时代的 restricted host，随单 host 重构与隔离决策调整而失效。

### 4.1 已落地：VSIX 市场签名（2026-08）

- **模型**：市场签名（非发布者签名）。发布管线 `scripts/gallery/publish.mjs --signing-key-file` 用市场 Ed25519 私钥对暂存 VSIX 字节签名，`sha256` + `signature{algorithm,keyId,value}` 写入 registry 版本条目，经 `/extensionquery` 的 `properties[]`（`Universe.Editor.VsixHash/VsixSignature/SignatureKeyId`）透出。
- **验签**：客户端 `installFromGallery` 用内置公钥（`marketplaceSigningKeys.ts`，keyId → JWK x）**强制验签，fail-closed**——未签名 / hash 不符 / 签名不通过 / 未知 keyId 一律拒装。本地 `installVSIX` **不验签**（用户显式选择的文件属显式信任，无市场签名可验）。
- **密钥**：私钥只存运维机/CI secret，绝不进 repo；`pnpm gallery:keygen` 生成。轮换 = 新客户端内置新 keyId 公钥（保留旧）→ 铺量后发布侧切 `--key-id`。测试/联调经 env `UNIVERSE_GALLERY_SIGNING_KEYS` 注入测试公钥。
- **防护定位**：防"包在托管/传输层被篡改"（篡改者拿不到离线私钥，无法伪造签名），与防投毒一致性校验（id+version）、恶意清单串行互补；**不防"发布者本身恶意"**，那仍靠 §2 的社会工程层。

## 5. 密钥红线（贯穿始终，不可退让）

无论隔离软硬，这条**现在就成立、且永远成立**：

- API key / secret **只在 main 进程**的 `ISecretStorageService`（Electron safeStorage 加密）。
- **绝不**进 renderer、settings.json、aiSettings.json、任何 wire DTO。
- 扩展**无任何接口**能读取这些密钥。AI 能力只对 **trusted**（内置）扩展开放（`bootstrap.ts` 里 AI 是 trusted-only），外部 restricted 扩展连 AI 桥都拿不到。

市场引入外部扩展后，这条红线是"扩展作者拿不到用户密钥"的保证，必须在 code review 中持续把关。

---

**本文结论**：MVP 的隔离是软的，且**诚实地软**——技术上外部扩展有接近本机的 Node 能力，防护靠发布者信任提示 + 恶意清单 + 一致性校验 + **市场签名验签（已落地，见 §4.1）** + 如实告知。硬隔离（权限模型/能力声明）经决策不做（隔离架构另行拍板）。密钥红线现在与将来都不退让。UI/文档措辞不得暗示"已沙箱"。
