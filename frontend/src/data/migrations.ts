import type { EntryRow } from './types'

// 存量数据迁移：版本号存在 localStorage 的 schema 键里，低于当前版本才跑，跑完写回。
// 迁移幂等：已补齐的记录再跑一遍不会变，重复执行安全。
export const SCHEMA_VERSION = 2

/** 调速器校验链路关心的数值字段：历史记录里可能整列缺失。 */
const GOVERNOR_NUMERIC_FIELDS = ['油压值', '导叶开度', '接力器行程', '开度限位'] as const

/**
 * 整组记录都缺某项时的兜底值（油压 MPa / 开度 % / 行程 mm / 限位 %）。
 * 决策：优先用同装置的历史有效值回填，实在没有才落兜底值，并一律打「迁移补录」标记，
 * 让补录记录在详情面板里能被一眼认出，不与实测值混淆。
 */
const GOVERNOR_FALLBACK: Record<(typeof GOVERNOR_NUMERIC_FIELDS)[number], string> = {
  油压值: '6.3',
  导叶开度: '0',
  接力器行程: '0',
  开度限位: '100',
}

/** 判定字段是否缺项：空串、占位横线、null/undefined 都算缺。 */
function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true
  }
  const text = String(value).trim()
  return text === '' || text === '—' || text === '-'
}

/** 校验日期可比较化：非法日期排到最后，保持原相对顺序。 */
function dateRank(value: unknown): string {
  const text = String(value ?? '')
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '9999-12-31'
}

/**
 * 回填一个装置分组内的缺项字段：
 * 1. 组内按校验日期升序，正向沿用上一次有效值（forward-fill）；
 * 2. 组首就缺的（没有更早值可沿用），用本组下一次有效值回填（back-fill）；
 * 3. 整组都缺，落模块兜底值。
 * 被补录的行打 `补录来源 = 迁移补录`，既有 status 等状态等级一律不改写。
 */
function backfillGovernorGroup(group: EntryRow[]): EntryRow[] {
  const sorted = [...group].sort(
    (a, b) => dateRank(a['校验日期']).localeCompare(dateRank(b['校验日期'])) || a.id - b.id,
  )
  const lastSeen = new Map<string, string>()
  const filled = sorted.map((row) => {
    const next: EntryRow = { ...row }
    let patched = false
    for (const field of GOVERNOR_NUMERIC_FIELDS) {
      const value = row[field]
      if (isMissing(value)) {
        const known = lastSeen.get(field)
        if (known !== undefined) {
          next[field] = known
          patched = true
        }
      } else {
        lastSeen.set(field, String(value))
      }
    }
    if (patched) {
      next['补录来源'] = '迁移补录'
    }
    return next
  })
  // 第二遍：处理组首缺项（正向没有可沿用的值），用本组后面的有效值回填。
  const nextSeen = new Map<string, string>()
  for (let i = filled.length - 1; i >= 0; i -= 1) {
    const row = filled[i]
    for (const field of GOVERNOR_NUMERIC_FIELDS) {
      const value = row[field]
      if (isMissing(value)) {
        const known = nextSeen.get(field)
        row[field] = known !== undefined ? known : GOVERNOR_FALLBACK[field]
        row['补录来源'] = '迁移补录'
      } else {
        nextSeen.set(field, String(value))
      }
    }
  }
  return filled
}

function migrateGovernor(rows: EntryRow[]): EntryRow[] {
  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const key = String(row['装置编号'] ?? row.id)
    const group = groups.get(key)
    if (group) {
      group.push(row)
    } else {
      groups.set(key, [row])
    }
  }
  const patched = new Map<number, EntryRow>()
  for (const group of groups.values()) {
    for (const row of backfillGovernorGroup(group)) {
      patched.set(row.id, row)
    }
  }
  // 保持原有行顺序：迁移只改内容，不改台账排列。
  return rows.map((row) => patched.get(row.id) ?? row)
}

/**
 * schema v2：
 * - 所有模块的记录补 revision（并发提交的基线版本，缺省从 1 开始）；
 * - 调速器历史记录按校验日期回填缺项字段。
 */
export function migrateRows(all: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(all)) {
    const withRevision = rows.map((row) =>
      row.revision === undefined ? { ...row, revision: 1 } : row,
    )
    next[key] = key === 'governor' ? migrateGovernor(withRevision) : withRevision
  }
  return next
}
