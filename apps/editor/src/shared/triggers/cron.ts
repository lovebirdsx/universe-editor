/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Minimal 5-field cron parser (`min hour dom month dow`) and next-fire calculator.
 *  Local time only; no external dependency.
 *--------------------------------------------------------------------------------------------*/

export interface CronSchedule {
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: readonly number[]
  readonly months: readonly number[]
  /** Normalized to 0 = Sunday; both 0 and 7 in the expression map to 0. */
  readonly daysOfWeek: readonly number[]
  readonly domRestricted: boolean
  readonly dowRestricted: boolean
}

export type ParseCronResult =
  | { readonly ok: true; readonly cron: CronSchedule }
  | { readonly ok: false; readonly error: string }

interface FieldSpec {
  readonly name: string
  readonly min: number
  readonly max: number
}

interface ParsedField {
  readonly values: readonly number[]
  readonly restricted: boolean
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
]

// Covers any real calendar day (including Feb 29) several times over.
const MAX_SCAN_DAYS = 4000

function parseInteger(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined
  return Number(text)
}

function parseField(
  field: string,
  spec: FieldSpec,
):
  | { readonly ok: true; readonly field: ParsedField }
  | { readonly ok: false; readonly error: string } {
  if (field.length === 0) return { ok: false, error: `empty ${spec.name} field` }
  const values = new Set<number>()
  for (const item of field.split(',')) {
    if (item.length === 0) return { ok: false, error: `empty item in ${spec.name} field` }
    const slashParts = item.split('/')
    if (slashParts.length > 2) {
      return { ok: false, error: `invalid ${spec.name} item "${item}"` }
    }
    const rangeText = slashParts[0]
    const stepText = slashParts[1]
    if (rangeText === undefined) {
      return { ok: false, error: `invalid ${spec.name} item "${item}"` }
    }
    let step = 1
    if (stepText !== undefined) {
      const parsedStep = parseInteger(stepText)
      if (parsedStep === undefined || parsedStep < 1) {
        return { ok: false, error: `invalid step "${stepText}" in ${spec.name} field` }
      }
      step = parsedStep
    }
    let start: number
    let end: number
    if (rangeText === '*') {
      start = spec.min
      end = spec.max
    } else if (rangeText.includes('-')) {
      const rangeParts = rangeText.split('-')
      if (rangeParts.length !== 2) {
        return { ok: false, error: `invalid range "${rangeText}" in ${spec.name} field` }
      }
      const from = rangeParts[0] === undefined ? undefined : parseInteger(rangeParts[0])
      const to = rangeParts[1] === undefined ? undefined : parseInteger(rangeParts[1])
      if (from === undefined || to === undefined) {
        return { ok: false, error: `invalid range "${rangeText}" in ${spec.name} field` }
      }
      if (from > to) {
        return { ok: false, error: `reversed range "${rangeText}" in ${spec.name} field` }
      }
      start = from
      end = to
    } else {
      const single = parseInteger(rangeText)
      if (single === undefined) {
        return { ok: false, error: `invalid value "${rangeText}" in ${spec.name} field` }
      }
      start = single
      end = stepText === undefined ? single : spec.max
    }
    if (start < spec.min || end > spec.max) {
      return {
        ok: false,
        error: `${spec.name} value out of range ${spec.min}-${spec.max}: "${item}"`,
      }
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return {
    ok: true,
    field: { values: [...values].sort((a, b) => a - b), restricted: field !== '*' },
  }
}

export function parseCron(expr: string): ParseCronResult {
  const trimmed = expr.trim()
  if (trimmed.length === 0) return { ok: false, error: 'cron expression is empty' }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    return { ok: false, error: `cron expression must have 5 fields, got ${parts.length}` }
  }
  const parsedFields: ParsedField[] = []
  for (let index = 0; index < FIELDS.length; index++) {
    const part = parts[index]
    const spec = FIELDS[index]
    if (part === undefined || spec === undefined) {
      return { ok: false, error: 'cron expression must have 5 fields' }
    }
    const parsed = parseField(part, spec)
    if (!parsed.ok) return parsed
    parsedFields.push(parsed.field)
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsedFields as [
    ParsedField,
    ParsedField,
    ParsedField,
    ParsedField,
    ParsedField,
  ]
  const normalizedDaysOfWeek = [...new Set(daysOfWeek.values.map((day) => (day === 7 ? 0 : day)))]
  normalizedDaysOfWeek.sort((a, b) => a - b)
  return {
    ok: true,
    cron: {
      minutes: minutes.values,
      hours: hours.values,
      daysOfMonth: daysOfMonth.values,
      months: months.values,
      daysOfWeek: normalizedDaysOfWeek,
      domRestricted: daysOfMonth.restricted,
      dowRestricted: daysOfWeek.restricted,
    },
  }
}

function matchesDay(cron: CronSchedule, date: Date): boolean {
  const dom = cron.daysOfMonth.includes(date.getDate())
  const dow = cron.daysOfWeek.includes(date.getDay())
  if (cron.domRestricted && cron.dowRestricted) return dom || dow
  if (cron.domRestricted) return dom
  if (cron.dowRestricted) return dow
  return true
}

function nextDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0)
}

/**
 * Next minute boundary strictly after `afterMs` that matches the schedule.
 * Returns `undefined` when the schedule can never fire (e.g. `0 0 31 2 *`).
 */
export function nextCronTime(cron: CronSchedule, afterMs: number): number | undefined {
  const start = new Date(afterMs)
  start.setSeconds(0, 0)
  let candidate = new Date(start.getTime() + 60_000)
  for (let day = 0; day < MAX_SCAN_DAYS; day++) {
    if (!cron.months.includes(candidate.getMonth() + 1) || !matchesDay(cron, candidate)) {
      candidate = nextDayStart(candidate)
      continue
    }
    const minHour = candidate.getHours()
    const minMinute = candidate.getMinutes()
    for (const hour of cron.hours) {
      if (hour < minHour) continue
      for (const minute of cron.minutes) {
        if (hour === minHour && minute < minMinute) continue
        const at = new Date(
          candidate.getFullYear(),
          candidate.getMonth(),
          candidate.getDate(),
          hour,
          minute,
          0,
          0,
        )
        if (at.getTime() <= afterMs) continue
        // DST shifts can move a constructed wall-clock time; skip mismatches.
        if (at.getHours() !== hour || at.getMinutes() !== minute) continue
        if (!cron.months.includes(at.getMonth() + 1) || !matchesDay(cron, at)) continue
        return at.getTime()
      }
    }
    candidate = nextDayStart(candidate)
  }
  return undefined
}
