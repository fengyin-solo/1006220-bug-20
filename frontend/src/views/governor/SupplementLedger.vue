<template>
  <div v-if="open" class="modal-mask" @click.self="close">
    <div class="modal wide">
      <header class="modal-head">
        <h3>历史缺项补录台账</h3>
        <button class="btn ghost" type="button" @click="close">关闭</button>
      </header>
      <p class="modal-tip">
        早期缺油压等读数的已校验记录按校验日期顺序补录，补录项单独成册，不在调速器台账里虚增记录；
        装置本身的历史等级原样保留，未做改写。
      </p>
      <table class="data-table">
        <thead>
          <tr><th>装置编号</th><th>所属机组</th><th>校验日期</th><th>补录字段</th><th>补录口径</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td>{{ item.deviceCode }}</td>
            <td>{{ item.unit }}</td>
            <td>{{ item.checkDate }}</td>
            <td>{{ item.fields.join('、') }}</td>
            <td>{{ item.rule }}</td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="5" class="empty-state">没有缺项补录记录</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { supplements } from '@/api/governor-service'
import type { GovernorSupplement } from '@/data/types'

const props = defineProps<{ open: boolean; nonce: number }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const items = computed<GovernorSupplement[]>(() => {
  void props.nonce
  return supplements()
})

function close() {
  emit('close')
}
</script>
