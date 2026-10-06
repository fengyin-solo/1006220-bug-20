/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

/** 调速器校验提交的载荷：五个字段随状态一次性落库，缺任何一项整笔退回。 */
export type CalibrationPayload = {
  油压值: string
  导叶开度: string
  接力器行程: string
  开度限位: string
  校验日期: string
}

/** 校验提交的结果：成功时带上落库后的整行，页面用它对齐详情面板与并发基线。 */
export type SubmitResult = ActionResult & {
  row?: EntryRow
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
