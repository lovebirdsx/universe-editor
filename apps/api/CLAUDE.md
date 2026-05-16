# apps/api/CLAUDE.md

Hono + Node 的独立后端 demo。**与 `apps/editor` / `packages/platform` 无耦合**，纯粹是 monorepo 中的"通用后端示例"。

## 命令

```bash
pnpm --filter @universe-editor/api dev      # tsx watch
pnpm --filter @universe-editor/api test     # vitest (node env)
pnpm --filter @universe-editor/api build
```

## 现有端点

- `GET /`：演示用，返回 JSON + 使用 `@universe-editor/shared` 的 `formatMoney`
- `GET /health`：返回 `{ status: 'ok' }`

## 加路由

在 `src/app.ts`：
```ts
app.get('/things/:id', (c) => c.json({ id: c.req.param('id') }))
app.post('/things', async (c) => {
  const body = await c.req.json<{ name: string }>()
  return c.json({ ok: true, name: body.name }, 201)
})
```

测试在 `src/__tests__/app.test.ts`，直接 `app.request('/things/1')` 模拟请求。

## 关键约束

- 测试环境：node（vitest 默认）
- ESM only：相对导入加 `.js` 后缀
- 不要 import `@universe-editor/platform`（保持解耦）
