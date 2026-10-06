import { MODULE_BY_KEY } from '@/data/modules'
import { commit, listRows, listSupplements, state } from '@/data/local-store'
import { isMissingReading, isValidDate } from '@/data/migration'
import type { ActionResult, EntryRow, GovernorCheckPayload } from '@/data/types'

// 调速器领域服务：提交校验是一条跨模块事务——
// 油压值/导叶开度/接力器行程/开度限位/校验日期与状态整笔写入调速器台账，
// 同一天仍在待调度的水情记录随结论一起推进；任一步写不成就整套退回。

const GOVERNOR_KEY = 'governor'
const HYDROLOGY_KEY = 'hydrology'
const TARGET_STATUS = '正常'
const FIELD_LABELS: Record<keyof GovernorCheckPayload, string> = {
  pressure: '油压值',
  opening: '导叶开度',
  stroke: '接力器行程',
  limit: '开度限位',
  checkDate: '校验日期',
}
const READING_LIMITS: Record<'pressure' | 'opening' | 'stroke' | 'limit', [number, number]> = {
  pressure: [0, 10],
  opening: [0, 100],
  stroke: [0, 500],
  limit: [0, 100],
}

export type GovernorStats = {
  normal: number
  pending: number
  abnormal: number
  stopped: number
  total: number
  supplemented: number
}

function canonical(value: string): string {
  const text = value.trim()
  if (text === '') {
    return ''
  }
  const num = Number(text)
  return Number.isNaN(num) ? text : String(Number(num.toFixed(3)))
}

export function validateCheckPayload(payload: GovernorCheckPayload): string {
  for (const key of ['pressure', 'opening', 'stroke', 'limit'] as const) {
    const text = payload[key].trim()
    if (text === '') {
      return `${FIELD_LABELS[key]}不能为空，提交校验需五项读数一次填齐`
    }
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      return `${FIELD_LABELS[key]}必须是数值，当前填的是「${text}」`
    }
    const num = Number(text)
    const [min, max] = READING_LIMITS[key]
    if (num < min || num > max) {
      return `${FIELD_LABELS[key]}超出允许范围（${min}~${max}），整笔退回，请核对后重新提交`
    }
  }
  const date = payload.checkDate.trim()
  if (!isValidDate(date)) {
    return '校验日期格式应为 YYYY-MM-DD 且为有效日期'
  }
  if (date > new Date().toISOString().slice(0, 10)) {
    return '校验日期不能晚于今天'
  }
  return ''
}

/** 同一台装置、同一组读数与日期构成一份报送：同一份数据重复报送只算一次。 */
function fingerprint(row: EntryRow, payload: GovernorCheckPayload): string {
  return [
    canonical(String(row['油压值'] ?? '')),
    canonical(String(row['导叶开度'] ?? '')),
    canonical(String(row['接力器行程'] ?? '')),
    canonical(String(row['开度限位'] ?? '')),
    String(row['校验日期'] ?? '').trim(),
  ].join('|')
}

function payloadFingerprint(payload: GovernorCheckPayload): string {
  return [
    canonical(payload.pressure),
    canonical(payload.opening),
    canonical(payload.stroke),
    canonical(payload.limit),
    payload.checkDate.trim(),
  ].join('|')
}

// 并发护栏：同一台调速器同时只能有一笔校验在落库，后到的一笔整笔拒绝。
const inflight = new Set<number>()

export async function submitGovernorCheck(
  id: number,
  payload: GovernorCheckPayload,
  baseRev: number,
): Promise<ActionResult & { linked: number }> {
  if (inflight.has(id)) {
    return { ok: false, message: '该调速器有一笔校验正在提交，后到的一笔已整笔退回', linked: 0 }
  }

  const validationError = validateCheckPayload(payload)
  if (validationError) {
    return { ok: false, message: validationError, linked: 0 }
  }

  inflight.add(id)
  // 让出一个微任务：双击、双面板同时提交时，第二笔能看到第一笔占着锁。
  await Promise.resolve()
  try {
    const store = state()
    const governors = store.data[GOVERNOR_KEY] ?? []
    const index = governors.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的调速器`, linked: 0 }
    }
    const current = governors[index]

    if (Number(current._rev ?? 0) !== baseRev) {
      return {
        ok: false,
        message: '该调速器已被另一笔提交更新过，本笔基于旧数据，已整笔拒绝写入',
        linked: 0,
      }
    }
    if (fingerprint(current, payload) === payloadFingerprint(payload) && current.status === TARGET_STATUS) {
      return { ok: false, message: '同一份校验数据已报送过，重复报送只算一次，后到的一份直接退回', linked: 0 }
    }

    const submittedAt = new Date().toISOString()
    const updatedGovernor: EntryRow = {
      ...current,
      status: TARGET_STATUS,
      pending: false,
      abnormal: false,
      _rev: Number(current._rev ?? 0) + 1,
      _supplemented: false,
      油压值: canonical(payload.pressure),
      导叶开度: canonical(payload.opening),
      接力器行程: canonical(payload.stroke),
      开度限位: canonical(payload.limit),
      校验日期: payload.checkDate.trim(),
      装置状态: TARGET_STATUS,
      最近提交时间: submittedAt,
    }

    // 跨模块联动：同一天还在待调度（待观测/已观测）的水情记录随校验结论推进到「已调度」。
    const hydroMeta = MODULE_BY_KEY.get(HYDROLOGY_KEY)!
    const pendingStatuses = hydroMeta.pendingStatuses ?? []
    const hydrology = store.data[HYDROLOGY_KEY] ?? []
    let linked = 0
    const nextHydrology = hydrology.map((row) => {
      if (
        String(row['观测时间'] ?? '') === payload.checkDate.trim() &&
        pendingStatuses.includes(String(row.status))
      ) {
        linked += 1
        return {
          ...row,
          status: '已调度',
          pending: false,
          abnormal: false,
          _rev: Number(row._rev ?? 0) + 1,
          调度状态: '已调度',
          联动说明: `随 ${updatedGovernor['装置编号']} 于 ${payload.checkDate.trim()} 的调速器校验结论联动`,
          联动时间: submittedAt,
        }
      }
      return row
    })

    const nextGovernors = [...governors]
    nextGovernors[index] = updatedGovernor

    // 一次性整库提交：localStorage 抛错（写满/隐私模式）时缓存不动，调速器与水情一起回退。
    try {
      commit({
        data: { ...store.data, [GOVERNOR_KEY]: nextGovernors, [HYDROLOGY_KEY]: nextHydrology },
        supplements: store.supplements,
      })
    } catch (error) {
      return {
        ok: false,
        message: `校验结果写库失败，整套改动已退回：${error instanceof Error ? error.message : '未知错误'}`,
        linked: 0,
      }
    }

    const suffix = linked > 0 ? `，同日 ${linked} 条待调度水情记录已随结论联动处理` : ''
    return {
      ok: true,
      message: `调速器 ${updatedGovernor['装置编号']} 校验已整笔入账（油压、开度、行程、限位、校验日期同写），状态「正常」${suffix}`,
      linked,
    }
  } finally {
    inflight.delete(id)
  }
}

export function governorStats(): GovernorStats {
  const rows = listRows(GOVERNOR_KEY)
  return {
    normal: rows.filter((row) => row.status === '正常').length,
    pending: rows.filter((row) => row.status === '待校验').length,
    abnormal: rows.filter((row) => row.status === '异常').length,
    stopped: rows.filter((row) => row.status === '已停用').length,
    total: rows.length,
    supplemented: rows.filter((row) => row._supplemented === true).length,
  }
}

export function supplements() {
  return listSupplements()
}

/** 详情面板读取：每次都从已提交的台账现读，避免打开两个入口看到两份数据。 */
export function getGovernor(id: number): EntryRow | undefined {
  return listRows(GOVERNOR_KEY).find((row) => Number(row.id) === id)
}

export function hasReadingGaps(row: EntryRow): boolean {
  return (
    isMissingReading('油压值', row['油压值']) ||
    isMissingReading('导叶开度', row['导叶开度']) ||
    isMissingReading('接力器行程', row['接力器行程']) ||
    isMissingReading('开度限位', row['开度限位']) ||
    !isValidDate(row['校验日期'])
  )
}
