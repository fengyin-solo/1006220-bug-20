<template>
  <div v-if="open" class="modal-mask" @click.self="cancel">
    <div class="modal">
      <header class="modal-head">
        <h3>提交调速器校验</h3>
        <button class="btn ghost" type="button" @click="cancel">关闭</button>
      </header>
      <p class="modal-tip">
        装置 {{ row?.['装置编号'] }}（{{ row?.['所属机组'] }}）：油压值、导叶开度、接力器行程、
        开度限位与校验日期一次性整笔写入，写不成就整套退回。
      </p>
      <form class="modal-form" @submit.prevent="submit">
        <label class="modal-field">
          <span>油压值（MPa）</span>
          <input v-model="form.pressure" inputmode="decimal" placeholder="如 2.50" />
        </label>
        <label class="modal-field">
          <span>导叶开度（%）</span>
          <input v-model="form.opening" inputmode="decimal" placeholder="如 82.5" />
        </label>
        <label class="modal-field">
          <span>接力器行程（mm）</span>
          <input v-model="form.stroke" inputmode="decimal" placeholder="如 165.0" />
        </label>
        <label class="modal-field">
          <span>开度限位（%）</span>
          <input v-model="form.limit" inputmode="decimal" placeholder="如 100" />
        </label>
        <label class="modal-field">
          <span>校验日期</span>
          <input v-model="form.checkDate" type="date" />
        </label>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <footer class="modal-foot">
          <button class="btn" type="button" :disabled="submitting" @click="cancel">取消</button>
          <button class="btn primary" type="submit" :disabled="submitting">
            {{ submitting ? '提交中…' : '整笔提交校验' }}
          </button>
        </footer>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'

import { submitGovernorCheck } from '@/api/governor-service'
import type { EntryRow, GovernorCheckPayload } from '@/data/types'

const props = defineProps<{ open: boolean; row: EntryRow | null }>()
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'done', message: string): void
}>()

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function blankForm(): GovernorCheckPayload {
  return { pressure: '', opening: '', stroke: '', limit: '100', checkDate: today() }
}

const form = reactive<GovernorCheckPayload>(blankForm())
const errorMessage = ref('')
const submitting = ref(false)

// 每次打开都用台账里的最新读数预填：同一台连续提交时，上一次的结果就是本次基线。
watch(
  () => [props.open, props.row?.id] as const,
  ([open]) => {
    if (!open || !props.row) {
      return
    }
    const row = props.row
    form.pressure = String(row['油压值'] ?? '')
    form.opening = String(row['导叶开度'] ?? '')
    form.stroke = String(row['接力器行程'] ?? '')
    form.limit = String(row['开度限位'] ?? '100') || '100'
    form.checkDate = String(row['校验日期'] ?? '') || today()
    errorMessage.value = ''
    submitting.value = false
  },
  { immediate: true },
)

function cancel() {
  if (submitting.value) {
    return
  }
  emit('close')
}

async function submit() {
  if (!props.row || submitting.value) {
    return
  }
  errorMessage.value = ''
  submitting.value = true
  try {
    const result = await submitGovernorCheck(
      Number(props.row.id),
      { ...form },
      Number(props.row._rev ?? 0),
    )
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    emit('done', result.message)
  } finally {
    submitting.value = false
  }
}
</script>
