/**
 * localStorage 持久化链路自检：mock 浏览器环境，验证播种迁移、版本升级、刷新保持与跨标签页一致。
 * 用法：npm run check（由 scripts/run-checks.sh 编译后执行）。
 */

// 先装好 window，再动态加载数据层（模块加载时会注册 storage 监听）。
const store = new Map<string, string>()
const listeners: Record<string, ((event: { key: string | null }) => void)[]> = {}
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => (store.has(key) ? store.get(key) : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  },
  addEventListener: (type: string, cb: (event: { key: string | null }) => void) => {
    ;(listeners[type] ??= []).push(cb)
  },
}

function fireStorage(key: string | null) {
  for (const cb of listeners['storage'] ?? []) {
    cb({ key })
  }
}

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

async function main() {
  const dataLayer = await import('@/data/local-store')
  const service = await import('@/api/local-service')
  const STORAGE = dataLayer.storageKey()
  const SCHEMA = 'hydropower-plant-om:schema'

  console.log('— 首次打开：播种即迁移，落库带版本 —')
  const first = dataLayer.listRows('governor')
  check('首次读取触发播种', first.length === 6, first.length)
  check('播种时缺项已回填', first.find((r) => r.id === 2)?.['油压值'] === '6.3')
  check('localStorage 已写入台账', store.has(STORAGE))
  check('schema 版本已记录', store.get(SCHEMA) === '2', store.get(SCHEMA))

  console.log('— 提交后刷新：记录保留原样 —')
  const before = service.countStatus('governor', '待校验')
  const submit = service.submitCalibration(
    'governor',
    3,
    { 油压值: '6.5', 导叶开度: '66', 接力器行程: '550', 开度限位: '95', 校验日期: service.today() },
    Number(first.find((r) => r.id === 3)?.revision ?? 0),
  )
  check('提交成功', submit.ok, submit)
  fireStorage(STORAGE) // 模拟刷新后缓存失效重读
  const reread = dataLayer.listRows('governor').find((r) => r.id === 3)
  check('刷新后油压值还是提交的值', reread?.['油压值'] === '6.5', reread)
  check('刷新后状态保持正常', reread?.status === '正常')
  check('刷新后待校验台数不回去', service.countStatus('governor', '待校验') === before - 1)

  console.log('— 旧版本数据：读取时按校验日期迁移回填 —')
  const legacy = JSON.parse(store.get(STORAGE) ?? '{}') as Record<string, unknown[]>
  ;(legacy['governor'] as Record<string, unknown>[]).push({
    id: 90,
    status: '正常',
    pending: false,
    abnormal: false,
    装置编号: 'GOVE-0001',
    所属机组: '1号机组',
    油压值: '',
    导叶开度: '',
    接力器行程: '545',
    开度限位: '93',
    校验日期: '2026-06-01',
    装置状态: '在运',
  })
  store.set(STORAGE, JSON.stringify(legacy))
  store.set(SCHEMA, '1')
  fireStorage(STORAGE)
  const migrated = dataLayer.listRows('governor').find((r) => r.id === 90)
  check('旧数据缺油压值被回填（同装置组首缺项用下一次有效值）', migrated?.['油压值'] === '6.1', migrated)
  check('旧数据缺导叶开度被回填', migrated?.['导叶开度'] === '62')
  check('补录记录带迁移标记', migrated?.['补录来源'] === '迁移补录')
  check('既有状态等级不改写', migrated?.status === '正常')
  check('迁移后版本落库', store.get(SCHEMA) === '2')

  console.log('— 另一个入口写入：两个入口读到的对得上 —')
  const other = JSON.parse(store.get(STORAGE) ?? '{}') as Record<string, { id: number }[]>
  const target = (other['governor'] as Record<string, unknown>[]).find((r) => r.id === 5)
  if (target) {
    target['油压值'] = '5.9'
  }
  store.set(STORAGE, JSON.stringify(other))
  fireStorage(STORAGE)
  check('本入口立刻读到另一入口的改动', dataLayer.listRows('governor').find((r) => r.id === 5)?.['油压值'] === '5.9')

  console.log('— 数据损坏：回退到迁移后的种子 —')
  store.set(STORAGE, '{broken json')
  fireStorage(STORAGE)
  const recovered = dataLayer.listRows('governor')
  check('损坏后回退种子且完成迁移', recovered.length === 6 && recovered.find((r) => r.id === 2)?.['油压值'] === '6.3')

  if (failures > 0) {
    console.error(`\n${failures} 项未通过`)
    process.exit(1)
  }
  console.log('\n全部通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
