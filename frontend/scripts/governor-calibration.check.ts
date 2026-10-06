/**
 * 调速器校验链路自检：在 node 里直接跑数据层（无 window，走内存缓存）。
 * 用法：npm run check（由 scripts/run-checks.sh 编译后执行）。
 */
import {
  countStatus,
  exportEntries,
  listEntries,
  runAction,
  submitCalibration,
  today,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { CalibrationPayload, EntryRow } from '@/data/types'

let failures = 0

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function row(id: number): EntryRow {
  const found = listRows('governor').find((item) => Number(item.id) === id)
  if (!found) {
    throw new Error(`记录 ${id} 不存在`)
  }
  return found
}

const payload = (overrides: Partial<CalibrationPayload> = {}): CalibrationPayload => ({
  油压值: '6.5',
  导叶开度: '66',
  接力器行程: '550',
  开度限位: '95',
  校验日期: today(),
  ...overrides,
})

console.log('— 存量迁移：按校验日期回填缺项 —')
check('GOVE-0002 早期记录缺油压值，用本组下一次有效值 6.3 补录', row(2)['油压值'] === '6.3', row(2))
check('GOVE-0002 补录记录打了迁移补录标记', row(2)['补录来源'] === '迁移补录')
check('GOVE-0001 九月记录缺导叶开度，沿用本组上一次 62', row(4)['导叶开度'] === '62', row(4))
check('GOVE-0001 九月记录缺开度限位，沿用本组上一次 92', row(4)['开度限位'] === '92')
check('GOVE-0001 九月记录也打了补录标记', row(4)['补录来源'] === '迁移补录')
check('字段齐全的记录不补录、不打标记', row(1)['补录来源'] === undefined)
check('既有状态等级不改写（正常/待校验/异常保持原样）',
  row(1).status === '正常' && row(3).status === '待校验' && row(5).status === '异常')
check('所有记录都补上了并发基线 revision',
  listRows('governor').every((item) => Number(item.revision) >= 1))

console.log('— 提交校验：五字段随状态一次性落库 —')
const before = countStatus('governor', '待校验')
const first = submitCalibration('governor', 3, payload(), Number(row(3).revision))
check('提交成功', first.ok, first)
check('油压值落库', row(3)['油压值'] === '6.5', row(3))
check('导叶开度落库', row(3)['导叶开度'] === '66')
check('接力器行程落库', row(3)['接力器行程'] === '550')
check('开度限位落库', row(3)['开度限位'] === '95')
check('校验日期落库为今天', row(3)['校验日期'] === today())
check('状态翻转为正常', row(3).status === '正常')
check('待办标记清除', row(3).pending === false)
check('版本号递增', Number(row(3).revision) === Number(first.row?.revision))
check('页脚待校验台数跟着减 1', countStatus('governor', '待校验') === before - 1)
check('列表入口读到的与详情一致', listEntries('governor').items.find((i) => i.id === 3)?.['油压值'] === '6.5')
check('导出清单与台账一致', exportEntries('governor').content.split('\n').some((line) => line.startsWith('3,') && line.includes('6.5')))

console.log('— 幂等：同一份数据重复报送只算一次 —')
const again = submitCalibration('governor', 3, payload(), Number(row(3).revision))
check('原样再报被退回', !again.ok && again.message.includes('重复报送'), again)
check('退回后库中值不变', row(3)['油压值'] === '6.5' && row(3)['导叶开度'] === '66')

console.log('— 连续两次提交：只落最后一次 —')
const second = submitCalibration('governor', 3, payload({ 导叶开度: '67', 油压值: '6.6' }), Number(row(3).revision))
check('第二笔不同数据提交成功', second.ok, second)
check('库中只落最后一次的值', row(3)['油压值'] === '6.6' && row(3)['导叶开度'] === '67', row(3))
check('记录数不变，没有写一半的中间记录', listRows('governor').filter((i) => i.id === 3).length === 1)

console.log('— 并发：只让第一笔生效，后到的整笔拒绝 —')
const staleBase = Number(row(3).revision)
const winA = submitCalibration('governor', 3, payload({ 油压值: '6.7' }), staleBase)
const winB = submitCalibration('governor', 3, payload({ 油压值: '9.9' }), staleBase)
check('第一笔生效', winA.ok, winA)
check('并发的第二笔整笔拒绝', !winB.ok && winB.message.includes('整笔退回'), winB)
check('库中是第一笔的值', row(3)['油压值'] === '6.7', row(3))

console.log('— 校验不过：整笔退回，一个字段都不写 —')
const beforeFail = JSON.stringify(row(3))
const badCases: [string, CalibrationPayload][] = [
  ['油压值留空', payload({ 油压值: '' })],
  ['油压值不是数值', payload({ 油压值: 'abc' })],
  ['油压值超量程', payload({ 油压值: '26' })],
  ['导叶开度超量程', payload({ 导叶开度: '101' })],
  ['校验日期是坏日期', payload({ 校验日期: '2026-02-30' })],
  ['校验日期是未来', payload({ 校验日期: '2999-01-01' })],
]
for (const [name, bad] of badCases) {
  const result = submitCalibration('governor', 3, bad, Number(row(3).revision))
  check(name, !result.ok, result)
}
check('全部退回后记录原样未动', JSON.stringify(row(3)) === beforeFail, row(3))

console.log('— 已停用装置不再接受校验 —')
check('停用前调速器待校验 1 台（水情页联动口径）', countStatus('governor', '待校验') === 1)
const stop = runAction('governor', 6, '停用装置')
check('停用动作成功', stop.ok, stop)
const afterStop = submitCalibration('governor', 6, payload(), Number(row(6).revision))
check('停用后提交被整笔退回', !afterStop.ok && afterStop.message.includes('已停用'), afterStop)
check('停用后待校验台数跟着变 0', countStatus('governor', '待校验') === 0)

console.log('— 旧路封堵：runAction 不允许只改状态 —')
const legacy = runAction('governor', 1, '提交校验')
check('裸提交校验被拒绝并引导到面板', !legacy.ok && legacy.message.includes('校验面板'), legacy)

console.log('— 跨模块：水情待办联动与既有流转不受影响 —')
const hydro = runAction('hydrology', 1, '提交观测')
check('水情记录正常流转', hydro.ok, hydro)

if (failures > 0) {
  console.error(`\n${failures} 项未通过`)
  process.exit(1)
}
console.log('\n全部通过')
