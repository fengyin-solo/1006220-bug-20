<template>
  <section class="page" data-module="governor">
    <header class="page-head">
      <div>
        <h2>调速器管理</h2>
        <p class="page-desc">维护调速器，围绕装置编号、所属机组、油压值、导叶开度做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记调速器</button>
        <button class="btn" type="button" @click="exportRows">导出调速器清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无调速器数据，可先登记调速器</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条调速器记录 · 待校验装置 {{ pendingCount }} 台</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="panelMode !== 'closed' && activeRow" class="drawer-mask" @click.self="closePanel">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>
            {{ panelMode === 'calibrate' ? '提交校验' : '调速器详情' }} · {{ activeRow['装置编号'] }}
          </h3>
          <button class="btn ghost" type="button" @click="closePanel">关闭</button>
        </header>

        <dl class="detail-grid">
          <template v-for="field in meta.fields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ activeRow[field] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ activeRow.status }}</dd>
          <template v-if="activeRow['补录来源']">
            <dt>补录来源</dt>
            <dd>{{ activeRow['补录来源'] }}</dd>
          </template>
        </dl>

        <form v-if="panelMode === 'calibrate'" class="calibration-form" @submit.prevent="submitForm">
          <p class="form-hint">油压值、导叶开度、接力器行程、开度限位与校验日期会随校验结论一次性落库；任何一项填不对都整笔退回。</p>
          <label v-for="field in calibrationFields" :key="field.name" class="filter-item">
            <span>{{ field.label }}</span>
            <input v-model="form[field.name]" :placeholder="field.placeholder" />
          </label>
          <div class="drawer-actions">
            <button class="btn primary" type="submit">提交校验</button>
            <button class="btn" type="button" @click="closePanel">取消</button>
          </div>
          <p v-if="panelError" class="error-text">{{ panelError }}</p>
        </form>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitCalibration,
  today,
} from '@/api/local-service'
import { listRows, storageKey } from '@/data/local-store'
import type { CalibrationPayload, EntryRow } from '@/data/types'

const meta = moduleMeta('governor')
const columns = ["装置编号", "所属机组", "油压值", "导叶开度", "接力器行程", "开度限位", "校验日期", "装置状态"]
const actions = ["提交校验", "标记异常", "停用装置"]
const statuses = ["待校验", "正常", "异常", "已停用"]

const rows = ref<EntryRow[]>([])
// 全量快照：统计卡、页脚待校验台数、详情面板都读它，保证与列表是同一份数据。
const snapshot = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const pendingCount = computed(
  () => snapshot.value.filter((row) => String(row.status) === '待校验').length,
)
const stats = computed(() => [
  { label: '正常调速器', value: snapshot.value.filter((row) => String(row.status) === '正常').length },
  { label: '待校验装置', value: pendingCount.value },
  { label: '异常装置', value: snapshot.value.filter((row) => String(row.status) === '异常').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 详情 / 校验面板：面板里的行始终从快照取，提交成功后看到的就是刚落库的值。
const panelMode = ref<'closed' | 'detail' | 'calibrate'>('closed')
const activeId = ref<number | null>(null)
const activeRow = computed(
  () => snapshot.value.find((row) => Number(row.id) === activeId.value) ?? null,
)
const baseRevision = ref(0)
const panelError = ref('')
const form = ref<CalibrationPayload>({ 油压值: '', 导叶开度: '', 接力器行程: '', 开度限位: '', 校验日期: '' })
const calibrationFields: { name: keyof CalibrationPayload; label: string; placeholder: string }[] = [
  { name: '油压值', label: '油压值（MPa）', placeholder: '如 6.3，范围 0~25' },
  { name: '导叶开度', label: '导叶开度（%）', placeholder: '如 62，范围 0~100' },
  { name: '接力器行程', label: '接力器行程（mm）', placeholder: '如 540，范围 0~2000' },
  { name: '开度限位', label: '开度限位（%）', placeholder: '如 92，范围 0~100' },
  { name: '校验日期', label: '校验日期', placeholder: 'YYYY-MM-DD，不能是未来日期' },
]

function textOf(value: unknown): string {
  const text = String(value ?? '').trim()
  return text === '—' ? '' : text
}

function openDetail(row: EntryRow) {
  activeId.value = Number(row.id)
  panelError.value = ''
  panelMode.value = 'detail'
}

function openCalibrate(row: EntryRow) {
  activeId.value = Number(row.id)
  // 并发基线：打开面板这一刻的版本。提交时对不上说明另一入口已改过，整笔退回。
  baseRevision.value = Number(row.revision ?? 0)
  form.value = {
    油压值: textOf(row['油压值']),
    导叶开度: textOf(row['导叶开度']),
    接力器行程: textOf(row['接力器行程']),
    开度限位: textOf(row['开度限位']),
    校验日期: today(),
  }
  panelError.value = ''
  panelMode.value = 'calibrate'
}

function closePanel() {
  panelMode.value = 'closed'
  activeId.value = null
  panelError.value = ''
}

function submitForm() {
  if (activeId.value === null) {
    return
  }
  panelError.value = ''
  const result = submitCalibration(meta.key, activeId.value, { ...form.value }, baseRevision.value)
  if (!result.ok) {
    // 整笔退回：库中值没动，刷新快照让面板详情对齐真实数据。
    panelError.value = result.message
    reload()
    return
  }
  // 连续提交只落最后一次：用返回的新版本号做下一次提交的并发基线。
  baseRevision.value = Number(result.row?.revision ?? baseRevision.value + 1)
  noticeMessage.value = result.message
  errorMessage.value = ''
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '调速器登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '提交校验') {
    openCalibrate(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    snapshot.value = [...listRows(meta.key)]
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '调速器列表读取失败'
  }
}

function onStorage(event: StorageEvent) {
  if (event.key === storageKey()) {
    reload()
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onStorage)
})

onBeforeUnmount(() => {
  window.removeEventListener('storage', onStorage)
})
</script>
