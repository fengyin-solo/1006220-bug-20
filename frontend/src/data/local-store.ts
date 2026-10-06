import { SEED_ROWS } from './seed'
import { migrateV1toV2 } from './migration'
import { MODULE_BY_KEY } from './modules'
import type { EntryRow, GovernorSupplement } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'
const META_KEY = 'hydropower-plant-om:meta'
const CURRENT_SCHEMA = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoreState = {
  data: Record<string, EntryRow[]>
  supplements: GovernorSupplement[]
}

let cache: StoreState | null = null

function readMeta(): { schema: number; supplements: GovernorSupplement[] } {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { schema: CURRENT_SCHEMA, supplements: [] }
  }
  const raw = window.localStorage.getItem(META_KEY)
  if (!raw) {
    return { schema: 1, supplements: [] }
  }
  try {
    const parsed = JSON.parse(raw) as { schema?: number; supplements?: GovernorSupplement[] }
    return { schema: Number(parsed.schema ?? 1), supplements: parsed.supplements ?? [] }
  } catch {
    return { schema: 1, supplements: [] }
  }
}

function writeMeta(schema: number, supplements: GovernorSupplement[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(META_KEY, JSON.stringify({ schema, supplements }))
}

function stampMigratedAt(supplements: GovernorSupplement[]): GovernorSupplement[] {
  const stamp = new Date().toISOString()
  return supplements.map((item) =>
    item.migratedAt === '' ? { ...item, migratedAt: stamp } : item,
  )
}

/** 读出的数据与种子合并后过一遍迁移：旧库升级、新库规范化，都只发生一次落库。 */
function loadFromStorage(): StoreState {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    const seeded = migrateV1toV2(
      fallback,
      MODULE_BY_KEY.get('governor')!,
      MODULE_BY_KEY.get('hydrology')!,
      [],
    )
    return { data: seeded.data, supplements: seeded.supplements }
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  const meta = readMeta()
  if (!raw) {
    const seeded = migrateV1toV2(
      fallback,
      MODULE_BY_KEY.get('governor')!,
      MODULE_BY_KEY.get('hydrology')!,
      meta.supplements,
    )
    const supplements = stampMigratedAt(seeded.supplements)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded.data))
    writeMeta(CURRENT_SCHEMA, supplements)
    return { data: seeded.data, supplements }
  }

  let parsed: Record<string, EntryRow[]>
  try {
    parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  } catch {
    const seeded = migrateV1toV2(
      fallback,
      MODULE_BY_KEY.get('governor')!,
      MODULE_BY_KEY.get('hydrology')!,
      [],
    )
    const supplements = stampMigratedAt(seeded.supplements)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded.data))
    writeMeta(CURRENT_SCHEMA, supplements)
    return { data: seeded.data, supplements }
  }

  const merged = { ...fallback, ...parsed }
  if (meta.schema < CURRENT_SCHEMA) {
    const migrated = migrateV1toV2(
      merged,
      MODULE_BY_KEY.get('governor')!,
      MODULE_BY_KEY.get('hydrology')!,
      meta.supplements,
    )
    const supplements = stampMigratedAt(migrated.supplements)
    // 一次写入两键：中间任何一步抛错，下次启动仍按旧 schema 整库重放，不会留下半迁移状态。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated.data))
    writeMeta(CURRENT_SCHEMA, supplements)
    return { data: migrated.data, supplements }
  }

  return { data: merged, supplements: meta.supplements }
}

export function state(): StoreState {
  if (cache === null) {
    cache = loadFromStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return state().data
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listSupplements(): GovernorSupplement[] {
  return state().supplements
}

/**
 * 整库原子提交：调用方先在快照上改好所有模块，最后一次性落盘。
 * 同一把写锁串行化并发提交，setItem 抛错时内存缓存原样保留，调用方按整笔失败处理。
 */
let writing = false
export function commit(next: StoreState): void {
  if (writing) {
    throw new Error('有一笔提交尚未落库，请稍后重试')
  }
  writing = true
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next.data))
      writeMeta(CURRENT_SCHEMA, next.supplements)
    }
    cache = next
  } finally {
    writing = false
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const current = state()
  commit({ data: { ...current.data, [key]: rows }, supplements: current.supplements })
}

export function resetRows(key: string): EntryRow[] {
  const current = state()
  // 重置也要走迁移：种子缺项一样按口径补录，且同一台账/字段不重复记账。
  const migrated = migrateV1toV2(
    { [key]: clone(SEED_ROWS[key] ?? []) },
    MODULE_BY_KEY.get('governor')!,
    MODULE_BY_KEY.get('hydrology')!,
    current.supplements,
  )
  const rows = migrated.data[key] ?? []
  const supplements = stampMigratedAt(migrated.supplements)
  commit({ data: { ...current.data, [key]: rows }, supplements })
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 另一个标签页落库后，清掉本页缓存，下次读取强制走 localStorage，保证两个入口读到同一份。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === META_KEY) {
      cache = null
    }
  })
}
