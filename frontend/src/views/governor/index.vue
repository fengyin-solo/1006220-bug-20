<template>
  <section class="page" data-module="governor">
    <header class="page-head">
      <div>
        <h2>调速器管理</h2>
        <p class="page-desc">提交校验时油压值、导叶开度、接力器行程、开度限位与校验日期整笔入账；列表、详情与导出清单同读一份台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="showLedger = true">缺项补录台账{{ supplementedCount ? `（${supplementedCount} 台）` : '' }}</button>
        <button class="btn" type="button" @click="exportRows">导出调速器清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">正常调速器</span>
        <strong class="stat-value">{{ stats.normal }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待校验装置</span>
        <strong class="stat-value">{{ stats.pending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">异常装置</span>
        <strong class="stat-value">{{ stats.abnormal }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已停用 / 历史补录</span>
        <strong class="stat-value">{{ stats.stopped }} / {{ stats.supplemented }}</strong>
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
          <td v-for="column in columns" :key="column">
            {{ row[column] === '' || row[column] == null ? '—' : row[column] }}
            <span v-if="column === '装置编号' && row._supplemented" class="tag warn" title="该装置早期缺测读数已按统一口径补录">补</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openCheck(row)">提交校验</button>
            <button
              v-if="row.status !== '已停用'"
              class="link" type="button"
              @click="runAction('标记异常', row)"
            >标记异常</button>
            <button
              v-if="row.status !== '已停用'"
              class="link" type="button"
              @click="runAction('停用装置', row)"
            >停用装置</button>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无调速器数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条调速器记录 · 待校验装置 <strong>{{ stats.pending }}</strong> 台
        <template v-if="lastMessage"><span class="ok-text">｜{{ lastMessage }}</span></template>
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <CheckDialog :open="checkOpen" :row="activeRow" @close="checkOpen = false" @done="onCheckDone" />
    <DetailPanel :open="detailOpen" :row="activeRow" :nonce="detailNonce" @close="detailOpen = false" />
    <SupplementLedger :open="showLedger" :nonce="detailNonce" @close="showLedger = false" />
  </section>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { governorStats } from '@/api/governor-service'
import type { EntryRow } from '@/data/types'
import CheckDialog from './CheckDialog.vue'
import DetailPanel from './DetailPanel.vue'
import SupplementLedger from './SupplementLedger.vue'

const meta = moduleMeta('governor')
const columns = meta.fields
const statuses = meta.statuses
const filterFields = columns.slice(0, 3)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const lastMessage = ref('')
const filters = ref<Record<string, string>>({})

const checkOpen = ref(false)
const detailOpen = ref(false)
const showLedger = ref(false)
const activeRow = ref<EntryRow | null>(null)
const detailNonce = ref(0)

// 统计始终从已提交的台账实时算，提交完、联动完、刷新回来都跟着变。
const stats = ref(governorStats())
const supplementedCount = computed(() => stats.value.supplemented)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function refreshStats() {
  stats.value = governorStats()
  detailNonce.value += 1
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCheck(row: EntryRow) {
  errorMessage.value = ''
  lastMessage.value = ''
  activeRow.value = row
  checkOpen.value = true
}

function openDetail(row: EntryRow) {
  activeRow.value = row
  detailOpen.value = true
  detailNonce.value += 1
}

function onCheckDone(message: string) {
  checkOpen.value = false
  lastMessage.value = message
  reload()
  refreshStats()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  lastMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  lastMessage.value = result.message
  reload()
  refreshStats()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '调速器列表读取失败'
  }
}

onMounted(reload)
// 没有 keep-alive 时 onActivated 不会触发；保留它是为了将来从详情/其他页返回时强制对一次账。
onActivated(reload)
</script>

<style scoped>
.tag { display: inline-block; margin-left: 4px; border-radius: 4px; padding: 0 5px; font-size: 11px; line-height: 16px; }
.tag.warn { background: #fef3c7; color: #92400e; }
.ok-text { color: #15803d; }
</style>
