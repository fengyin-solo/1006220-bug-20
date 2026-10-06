import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  CalibrationPayload,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  SubmitResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 调速器校验提交时随状态一起落库的数值字段及其量程（油压 MPa / 开度 % / 行程 mm / 限位 %）。
const CALIBRATION_NUMERIC_RULES: { field: '油压值' | '导叶开度' | '接力器行程' | '开度限位'; min: number; max: number }[] = [
  { field: '油压值', min: 0, max: 25 },
  { field: '导叶开度', min: 0, max: 100 },
  { field: '接力器行程', min: 0, max: 2000 },
  { field: '开度限位', min: 0, max: 100 },
]

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 某模块下处于指定状态的记录数：页脚台数、跨模块待办联动都用它，读的是同一份数据。 */
export function countStatus(key: string, status: string): number {
  return listRows(key).filter((row) => String(row.status) === status).length
}

/** 本地今天，YYYY-MM-DD：校验日期默认值与「不许填未来日期」的界线。 */
export function today(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

function isValidDateText(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false
  }
  const parsed = new Date(`${text}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return false
  }
  const mm = String(parsed.getMonth() + 1).padStart(2, '0')
  const dd = String(parsed.getDate()).padStart(2, '0')
  return `${parsed.getFullYear()}-${mm}-${dd}` === text
}

/** 数值字段规范化：去掉空白、统一成 canonical 字符串，重复报送比较时 6.30 与 6.3 算同一份。 */
function normalizeNumber(raw: string): string | null {
  const text = raw.trim()
  if (text === '') {
    return null
  }
  const value = Number(text)
  return Number.isFinite(value) ? String(value) : null
}

function sameFieldValue(a: unknown, b: unknown): boolean {
  const na = Number(String(a ?? '').trim())
  const nb = Number(String(b ?? '').trim())
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
    return na === nb
  }
  return String(a ?? '') === String(b ?? '')
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === 'governor' && action === '提交校验') {
    // 调速器校验必须带着油压值等数据走 submitCalibration，堵住「只写状态不写字段」的旧路。
    return { ok: false, message: '调速器校验需在校验面板填写油压值、导叶开度、接力器行程、开度限位与校验日期后提交' }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    revision: Number(rows[index].revision ?? 0) + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 调速器提交校验：油压值、导叶开度、接力器行程、开度限位、校验日期随状态一次性落库。
 * 防线按顺序执行，任何一道不过都整笔退回、一个字段都不写：
 * 1. 并发：baseRevision 与库中不一致，说明另一入口已改过，后到的整笔拒绝；
 * 2. 状态：已停用的装置不再接受校验；
 * 3. 字段：数值要在量程内，校验日期要合法且不晚于今天；
 * 4. 幂等：五字段与库中完全相同的重复报送只算一次，后到的退回；
 * 通过后在内存里拼好整行再一次持久化，中间不落地任何写了一半的记录。
 */
export function submitCalibration(
  key: string,
  id: number,
  payload: CalibrationPayload,
  baseRevision: number,
): SubmitResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets['提交校验']
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「提交校验」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]
  if (Number(current.revision ?? 0) !== baseRevision) {
    return { ok: false, message: `${meta.entity}刚被另一入口更新过，本次整笔退回，请刷新核对后再提交` }
  }
  if (String(current.status) === meta.statuses[meta.statuses.length - 1]) {
    return { ok: false, message: `${meta.entity}已停用，不再接受校验提交` }
  }
  const normalized: Record<string, string> = {}
  for (const rule of CALIBRATION_NUMERIC_RULES) {
    const value = normalizeNumber(String(payload[rule.field] ?? ''))
    if (value === null) {
      return { ok: false, message: `${rule.field}要填数值，本次未写入任何字段` }
    }
    if (Number(value) < rule.min || Number(value) > rule.max) {
      return { ok: false, message: `${rule.field}超出量程 ${rule.min}~${rule.max}，本次未写入任何字段` }
    }
    normalized[rule.field] = value
  }
  const date = String(payload['校验日期'] ?? '').trim()
  if (!isValidDateText(date)) {
    return { ok: false, message: '校验日期要按 YYYY-MM-DD 填真实日期，本次未写入任何字段' }
  }
  if (date > today()) {
    return { ok: false, message: '校验日期不能是未来日期，本次未写入任何字段' }
  }
  normalized['校验日期'] = date
  const duplicated = [...CALIBRATION_NUMERIC_RULES.map((rule) => rule.field), '校验日期'].every(
    (field) => sameFieldValue(current[field], normalized[field]),
  )
  if (duplicated) {
    return { ok: false, message: '同一份校验数据已报送过，重复报送只算一次，后到的这份已退回' }
  }
  const updated: EntryRow = {
    ...current,
    ...normalized,
    status: target,
    pending: false,
    abnormal: false,
    revision: Number(current.revision ?? 0) + 1,
    补录来源: '',
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}校验已提交，油压值、导叶开度、接力器行程、开度限位与校验日期已一并落库`, row: updated }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
