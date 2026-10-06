/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 行版本号：每次落库 +1，乐观并发控制用，页面不展示。 */
  _rev?: number
  /** 历史回填标记：缺失字段被补录时为 true，页面只在详情里展示。 */
  _supplemented?: boolean
  [field: string]: string | number | boolean | undefined
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
  /** 计入「待办」的状态；不配置时沿用旧口径（非末状态都算待办）。 */
  pendingStatuses?: string[]
  /** 计入「异常」的状态；不配置时沿用旧口径（负向动词动作产生异常标记）。 */
  abnormalStatuses?: string[]
  /** 需要整笔事务提交（业务字段随状态一起落库）的动作。 */
  txActions?: string[]
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

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 调速器提交校验时一次性写入的读数（油压/开度/行程/限位/日期）。 */
export type GovernorCheckPayload = {
  pressure: string
  opening: string
  stroke: string
  limit: string
  checkDate: string
}

/** 早期缺项记录的补录明细：单独成册，不在调速器台账里虚增行。 */
export type GovernorSupplement = {
  id: number
  governorId: number
  deviceCode: string
  unit: string
  checkDate: string
  fields: string[]
  rule: string
  migratedAt: string
}
