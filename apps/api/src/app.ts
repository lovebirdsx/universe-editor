import { Hono } from 'hono'
import { formatMoney } from '@acme/shared'

const app = new Hono()

app.get('/', (c) => {
  return c.json({
    message: 'Acme API',
    demo: {
      price_usd: formatMoney(49.99),
      price_eur: formatMoney(129.0, 'EUR'),
    },
    timestamp: new Date().toISOString(),
  })
})

app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

export { app }
