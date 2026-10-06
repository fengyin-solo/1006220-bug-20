import type { EntryRow, GovernorSupplement, ModuleMeta } from './types'

// 存量数据迁移：旧库只改了状态字段、读数栏全是占位文字，迁移时一次性补齐并单独记账。
// 迁移只补读数、不动历史等级；补出来的值一律带 _supplemented 标记，并在补录台账里留痕。

export const CALIBRATED_STATUSES = ['正常', '异常']
const PENDING_STATUS = '待校验'
const STOPPED_STATUS = '已停用'

/** 早期缺测读数的补录口径：额定油压 / 额定开度 / 全开限位 / 行程传动比，都写死在这里，不凭空发挥。 */
export const NOMINAL_RULES = {
  pressure: { value: '2.50', label: '油压值', rule: '早期缺测，按调速器额定压力油源 2.50 MPa 补录' },
  opening: { value: '80.0', label: '导叶开度', rule: '早期缺测，按额定工况导叶开度 80.0% 补录' },
  stroke: { value: '160.0', label: '接力器行程', rule: '早期缺测，按导叶开度 ×2.0 行程传动比补录（全行程 200mm）' },
  limit: { value: '100', label: '开度限位', rule: '早期缺测，按机械全开限位 100% 补录' },
  date: { value: '', label: '校验日期', rule: '早期缺登记，按存量记录时间顺序排定校验日期' },
} as const

const RANGES: Record<string, [number, number]> = {
  油压值: [0, 10],
  导叶开度: [0, 100],
  接力器行程: [0, 500],
  开度限位: [0, 100],
}

/** 占位文字或越界数字都算缺测：例如旧库里的「调速器样例1」。 */
export function isMissingReading(field: string, raw: unknown): boolean {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return true
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return true
  }
  const range = RANGES[field]
  if (range) {
    const num = Number(text)
    return Number.isNaN(num) || num < range[0] || num > range[1]
  }
  return false
}

export function isValidDate(value: unknown): boolean {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false
  }
  const [y, m, d] = text.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

function looksLikePlaceholder(text: unknown): boolean {
  const value = String(text ?? '').trim()
  return value !== '' && (!/^-?\d+(\.\d+)?$/.test(value) || /样例\d*$/.test(value))
}

function recalcFlags(row: EntryRow, meta: ModuleMeta): void {
  if (meta.pendingStatuses) {
    row.pending = meta.pendingStatuses.includes(String(row.status))
  }
  if (meta.abnormalStatuses) {
    row.abnormal = meta.abnormalStatuses.includes(String(row.status))
  }
  if (typeof row._rev !== 'number') {
    row._rev = 0
  }
}

/** 给缺校验日期的已校验记录按时间顺序排日期：从最早一条已知日期往前每 30 天排一条。 */
function backfillDates(rows: EntryRow[]): Map<number, string> {
  const assigned = new Map<number, string>()
  const calibrated = rows.filter((row) => CALIBRATED_STATUSES.includes(String(row.status)))
  const knownDates = calibrated
    .filter((row) => isValidDate(row['校验日期']))
    .map((row) => String(row['校验日期']))
    .sort()
  const undated = calibrated
    .filter((row) => !isValidDate(row['校验日期']))
    .sort((a, b) => Number(a.id) - Number(b.id))
  if (undated.length === 0) {
    return assigned
  }
  const base = knownDates.length > 0 ? new Date(knownDates[0] + 'T00:00:00') : new Date('2025-01-15T00:00:00')
  undated.forEach((row, index) => {
    const date = new Date(base.getTime() - (undated.length - index) * 30 * 24 * 3600 * 1000)
    assigned.set(Number(row.id), date.toISOString().slice(0, 10))
  })
  return assigned
}

export type MigrationResult = {
  data: Record<string, EntryRow[]>
  supplements: GovernorSupplement[]
}

/**
 * 迁移调速器与水情两张表：
 * - 调速器：已校验记录的缺测读数按额定口径补录、单独进补录台账，等级保持原样不改写；
 *           待校验/已停用记录只清占位文字，不虚构造假读数；待办/异常标记按状态重算。
 * - 水情：无效占位水位/流量清空（不虚构水情数据），待办口径按模块元数据重算。
 * 其他模块只补 _rev，不动存量。
 */
export function migrateV1toV2(
  data: Record<string, EntryRow[]>,
  governorMeta: ModuleMeta,
  hydrologyMeta: ModuleMeta,
  existing: GovernorSupplement[] = [],
): MigrationResult {
  const next: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(data)) {
    next[key] = rows.map((row) => ({ ...row }))
  }

  const supplements = [...existing]
  const knownLedgerKeys = new Set(existing.map((item) => `${item.governorId}:${item.fields.join('|')}`))
  const governors = next['governor'] ?? []
  const dateAssignments = backfillDates(governors)
  let ledgerId = supplements.reduce((max, item) => Math.max(max, item.id), 0)

  const recordSupplement = (
    row: EntryRow,
    fields: string[],
    rule: string,
  ): void => {
    if (fields.length === 0) {
      return
    }
    const ledgerKey = `${row.id}:${fields.join('|')}`
    if (knownLedgerKeys.has(ledgerKey)) {
      return
    }
    knownLedgerKeys.add(ledgerKey)
    ledgerId += 1
    supplements.push({
      id: ledgerId,
      governorId: Number(row.id),
      deviceCode: String(row['装置编号'] ?? ''),
      unit: String(row['所属机组'] ?? ''),
      checkDate: String(row['校验日期'] ?? ''),
      fields,
      rule,
      migratedAt: '',
    })
  }

  for (const row of governors) {
    recalcFlags(row, governorMeta)
    const status = String(row.status)
    if (looksLikePlaceholder(row['装置状态']) || String(row['装置状态'] ?? '').trim() === '') {
      row['装置状态'] = status
    }

    if (status === PENDING_STATUS) {
      // 还没校验：旧库里残留的占位读数与日期整列清空，等真正提交校验时一次写齐。
      row['油压值'] = ''
      row['导叶开度'] = ''
      row['接力器行程'] = ''
      row['开度限位'] = ''
      row['校验日期'] = ''
      continue
    }

    if (!CALIBRATED_STATUSES.includes(status)) {
      // 已停用等非在校状态：只清无效占位，不补造数据。
      for (const field of ['油压值', '导叶开度', '接力器行程', '开度限位']) {
        if (looksLikePlaceholder(row[field])) {
          row[field] = ''
        }
      }
      if (!isValidDate(row['校验日期'])) {
        row['校验日期'] = ''
      }
      continue
    }

    // 已校验历史记录：缺什么补什么，补录字段单独成册。
    const supplementedFields: string[] = []

    if (!isValidDate(row['校验日期'])) {
      const assigned = dateAssignments.get(Number(row.id))
      if (assigned) {
        row['校验日期'] = assigned
        supplementedFields.push(NOMINAL_RULES.date.label)
        recordSupplement(row, [NOMINAL_RULES.date.label], NOMINAL_RULES.date.rule)
      }
    }

    if (isMissingReading('导叶开度', row['导叶开度'])) {
      row['导叶开度'] = NOMINAL_RULES.opening.value
      supplementedFields.push(NOMINAL_RULES.opening.label)
      recordSupplement(row, [NOMINAL_RULES.opening.label], NOMINAL_RULES.opening.rule)
    }

    if (isMissingReading('油压值', row['油压值'])) {
      row['油压值'] = NOMINAL_RULES.pressure.value
      supplementedFields.push(NOMINAL_RULES.pressure.label)
      recordSupplement(row, [NOMINAL_RULES.pressure.label], NOMINAL_RULES.pressure.rule)
    }

    if (isMissingReading('接力器行程', row['接力器行程'])) {
      // 优先按本次（含补录后的）导叶开度换算，保证开度与行程对得上。
      const stroke = (Number(row['导叶开度']) * 2).toFixed(1)
      row['接力器行程'] = stroke
      supplementedFields.push(NOMINAL_RULES.stroke.label)
      recordSupplement(row, [NOMINAL_RULES.stroke.label], NOMINAL_RULES.stroke.rule)
    }

    if (isMissingReading('开度限位', row['开度限位'])) {
      row['开度限位'] = NOMINAL_RULES.limit.value
      supplementedFields.push(NOMINAL_RULES.limit.label)
      recordSupplement(row, [NOMINAL_RULES.limit.label], NOMINAL_RULES.limit.rule)
    }

    if (supplementedFields.length > 0) {
      row['_supplemented'] = true
    }
  }
  // 补录台账按校验日期升序，与「存量数据按时间顺序回填」一致。
  supplements.sort((a, b) =>
    a.checkDate === b.checkDate ? a.governorId - b.governorId : a.checkDate.localeCompare(b.checkDate),
  )

  const hydrology = next['hydrology'] ?? []
  for (const row of hydrology) {
    recalcFlags(row, hydrologyMeta)
    for (const field of ['上游水位', '下游水位', '入库流量', '出库流量']) {
      if (looksLikePlaceholder(row[field])) {
        row[field] = ''
      }
    }
    if (looksLikePlaceholder(row['调度状态']) || String(row['调度状态'] ?? '').trim() === '') {
      row['调度状态'] = String(row.status)
    }
  }

  return { data: next, supplements }
}
