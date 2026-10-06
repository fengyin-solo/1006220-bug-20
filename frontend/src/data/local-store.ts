import { migrateRows, SCHEMA_VERSION } from './migrations'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'
const SCHEMA_KEY = 'hydropower-plant-om:schema'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function persist(rows: Record<string, EntryRow[]>): void {
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
    window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
  }
}

function readSchemaVersion(): number {
  if (!hasStorage()) {
    return SCHEMA_VERSION
  }
  const raw = window.localStorage.getItem(SCHEMA_KEY)
  const version = Number(raw)
  return Number.isFinite(version) && version > 0 ? version : 1
}

function readStorage(): Record<string, EntryRow[]> {
  const seeded = clone(SEED_ROWS)
  if (!hasStorage()) {
    // 无存储环境（如脚本自检）：同样过一遍迁移，保证读到的是补齐后的结构。
    return migrateRows(seeded)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fresh = migrateRows(seeded)
    persist(fresh)
    return fresh
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...seeded, ...parsed }
    if (readSchemaVersion() < SCHEMA_VERSION) {
      const migrated = migrateRows(merged)
      persist(migrated)
      return migrated
    }
    return merged
  } catch {
    const fresh = migrateRows(seeded)
    persist(fresh)
    return fresh
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 另一个标签页（另一个入口）写入后，本页缓存立刻失效，两个入口读到的对得上。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      cache = null
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = migrateRows({ [key]: clone(SEED_ROWS[key] ?? []) })[key] ?? []
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
