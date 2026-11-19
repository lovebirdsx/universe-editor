import { configure } from '@testing-library/react'

// 与 apps/editor 根节点的 StrictMode 对齐：dev 下 effect 双调用暴露非幂等 cleanup。
configure({ reactStrictMode: true })
