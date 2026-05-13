// M1 起这里会承载 VSCode 风格内核：DI、Lifecycle、Command、Contribution、IPC、Config、Log。
// M0 只导出一个标识函数，证明包注册、composite build、Vitest 都跑通。
export const hello = (): string => 'platform'
