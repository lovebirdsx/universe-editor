import { useState } from 'react'
import { Button } from '@acme/ui'
import { formatMoney, cn } from '@acme/shared'

const PRODUCTS = [
  { id: 1, name: 'Widget Pro', price: 49.99 },
  { id: 2, name: 'Gadget Plus', price: 129.0 },
  { id: 3, name: 'Doohickey', price: 9.99 },
] as const

export default function App() {
  const [selected, setSelected] = useState<number | null>(null)

  return (
    <main
      className={cn('p-8', 'font-sans')}
      style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>Acme Monorepo Demo</h1>
      <p style={{ color: '#666', marginBottom: '1.5rem' }}>
        Built with pnpm workspaces + TypeScript Project References + Turborepo
      </p>

      <ul style={{ listStyle: 'none', padding: 0, display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        {PRODUCTS.map((p) => (
          <li
            key={p.id}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: '0.5rem',
              padding: '1rem',
              minWidth: '160px',
              background: selected === p.id ? '#eff6ff' : '#fff',
            }}
          >
            <div style={{ fontWeight: 600 }}>{p.name}</div>
            <div style={{ color: '#2563eb', marginBottom: '0.75rem' }}>{formatMoney(p.price)}</div>
            <Button
              variant={selected === p.id ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => setSelected(selected === p.id ? null : p.id)}
            >
              {selected === p.id ? 'Deselect' : 'Select'}
            </Button>
          </li>
        ))}
      </ul>

      {selected !== null && (
        <p style={{ marginTop: '1.5rem', color: '#16a34a' }}>
          Selected: <strong>{PRODUCTS.find((p) => p.id === selected)?.name}</strong>
        </p>
      )}
    </main>
  )
}
