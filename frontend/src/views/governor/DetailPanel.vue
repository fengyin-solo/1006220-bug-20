<template>
  <aside v-if="open" class="drawer-mask" @click.self="close">
    <div class="drawer">
      <header class="drawer-head">
        <h3>调速器详情</h3>
        <button class="btn ghost" type="button" @click="close">关闭</button>
      </header>
      <template v-if="fresh">
        <table class="detail-table">
          <tbody>
            <tr v-for="field in fields" :key="field">
              <th>{{ field }}</th>
              <td>{{ fresh[field] === '' || fresh[field] == null ? '—' : fresh[field] }}</td>
            </tr>
            <tr>
              <th>当前状态</th>
              <td>{{ fresh.status }}</td>
            </tr>
            <tr v-if="fresh['最近提交时间']">
              <th>最近提交时间</th>
              <td>{{ fresh['最近提交时间'] }}</td>
            </tr>
            <tr>
              <th>数据来源</th>
              <td>
                <span v-if="fresh._supplemented" class="tag warn">含历史缺项补录</span>
                <span v-else class="tag ok">校验实测入账</span>
              </td>
            </tr>
          </tbody>
        </table>

        <section v-if="deviceSupplements.length" class="supplement-block">
          <h4>该装置的缺项补录明细</h4>
          <table class="data-table">
            <thead>
              <tr><th>校验日期</th><th>补录字段</th><th>补录口径</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in deviceSupplements" :key="item.id">
                <td>{{ item.checkDate }}</td>
                <td>{{ item.fields.join('、') }}</td>
                <td>{{ item.rule }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
      <p v-else class="empty-state">台账里已没有这条调速器记录</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { getGovernor, supplements } from '@/api/governor-service'
import { moduleMeta } from '@/api/local-service'
import type { EntryRow, GovernorSupplement } from '@/data/types'

const props = defineProps<{ open: boolean; row: EntryRow | null; nonce: number }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const meta = moduleMeta('governor')
const fields = meta.fields

// nonce 每次变化都重新现读：提交完、从列表回来、别的标签页改过，面板都拿最新台账。
const fresh = computed<EntryRow | undefined>(() => {
  void props.nonce
  if (!props.row) {
    return undefined
  }
  return getGovernor(Number(props.row.id))
})

const deviceSupplements = computed<GovernorSupplement[]>(() => {
  void props.nonce
  const id = props.row ? Number(props.row.id) : NaN
  if (Number.isNaN(id)) {
    return []
  }
  return supplements().filter((item) => item.governorId === id)
})

function close() {
  emit('close')
}
</script>
