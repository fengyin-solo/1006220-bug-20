import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
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
  const pending = meta.pendingStatuses
    ? meta.pendingStatuses.includes(target)
    : target !== meta.statuses[meta.statuses.length - 1]
  const abnormal = meta.abnormalStatuses
    ? meta.abnormalStatuses.includes(target)
    : NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending,
    abnormal,
    _rev: Number(rows[index]._rev ?? 0) + 1,
  }
  // 「装置状态/调度状态」这类业务状态列与流转状态保持同一份，列表与详情才不会对不上。
  for (const field of meta.fields) {
    if (field.endsWith('状态')) {
      updated[field] = target
    }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
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

export function hydrologyStats(): { inflow: number; outflow: number; pending: number; today: string } {
  const rows = listRows('hydrology')
  const today = new Date().toISOString().slice(0, 10)
  // 今日没有观测记录时按最新一条已观测/已调度记录汇总，页脚数字始终有来源。
  const todays = rows.filter((row) => String(row['观测时间'] ?? '') === today)
  const source = todays.length > 0
    ? todays
    : rows
        .filter((row) => row.status === '已观测' || row.status === '已调度' || row.status === '已复核')
        .sort((a, b) => String(b['观测时间'] ?? '').localeCompare(String(a['观测时间'] ?? '')))
        .slice(0, 1)
  const sum = (field: string) =>
    source.reduce((total, row) => {
      const num = Number(row[field])
      return total + (Number.isFinite(num) ? num : 0)
    }, 0)
  const meta = MODULE_BY_KEY.get('hydrology')!
  const pendingStatuses = meta.pendingStatuses ?? []
  return {
    inflow: sum('入库流量'),
    outflow: sum('出库流量'),
    pending: rows.filter((row) => pendingStatuses.includes(String(row.status))).length,
    today,
  }
}

export function loadOverview(): OverviewResult {  const rows = allRows()
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
