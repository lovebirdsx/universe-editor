/**
 * 货币格式化工具，使用 Intl.NumberFormat 保证本地化输出。
 */
export function formatMoney(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount)
}

/**
 * 合并 className 字符串，过滤 falsy 值。
 * 可与 Tailwind CSS 搭配使用。
 */
export function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ')
}
