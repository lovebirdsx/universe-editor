# packages/mobile-protocol/CLAUDE.md

手机网关 wire 协议的唯一真相：main 网关（Node）与 `apps/mobile` PWA（浏览器）共同 import。设计与取舍见 `docs/development/mobile-gateway.md` §4/§8。

## 零依赖红线

- `dependencies` 为空；不得 import `node:*`、`electron`、其它 `@universe-editor/*`。只用两端都有的标准全局（`globalThis.crypto`、`URLSearchParams`）。
- 校验器手写，不引 zod；改字段同步 `validate.ts` 与 `__tests__/`。

## 改协议

- 帧字段、错误码语义、关闭码有任何 wire 变化，必须 bump `MOBILE_PROTOCOL_VERSION` 并同步 `docs/development/mobile-gateway.md`。
- 联合类型按 `type` 判别；新消息加接口并入 `ClientFrame` / `ServerFrame`，未知 type 返回 `bad_request`。
