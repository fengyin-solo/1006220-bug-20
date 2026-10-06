// 调速器提交链路的集成校验：用内存 localStorage 模拟浏览器，打包 src 后在 Node 里跑。
// 覆盖：整笔齐写、连提只留最后一次、重复报送退回、并发第一笔生效、写失败回滚、
//       水情联动、历史回填与补录台账、刷新持久化、导出与台账一致。
const esbuild = require('esbuild')
const path = require('path')
const assert = require('assert')

function createLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (key === '__forceFail__') {
        throw new Error('模拟写入失败')
      }
      map.set(key, String(value))
    },
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  }
}

async function loadApp(initialStorage = {}) {
  const localStorage = createLocalStorage(initialStorage)
  globalThis.window = { localStorage, addEventListener: () => {} }
  // 用一个运行时入口把三个模块拉进同一份 bundle，保证共享同一个 local-store 实例（与页面一致）。
  const entry = `
    export * from '${path.resolve(__dirname, '../src/api/governor-service.ts').replace(/\\/g, '/')}'
    export { listRows, listSupplements, storageKey } from '${path.resolve(__dirname, '../src/data/local-store.ts').replace(/\\/g, '/')}'
    export { listEntries, exportEntries, hydrologyStats } from '${path.resolve(__dirname, '../src/api/local-service.ts').replace(/\\/g, '/')}'
  `
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    alias: { '@': path.resolve(__dirname, '../src') },
  })
  const mod = { exports: {} }
  const fn = new Function('module', 'exports', 'window', result.outputFiles[0].text)
  fn(mod, mod.exports, globalThis.window)
  const all = mod.exports
  return {
    gov: all,
    store: { listRows: all.listRows, listSupplements: all.listSupplements, storageKey: all.storageKey },
    svc: { listEntries: all.listEntries, exportEntries: all.exportEntries, hydrologyStats: all.hydrologyStats },
    localStorage,
  }
}

const payload = (over = {}) => ({
  pressure: '2.55',
  opening: '85.0',
  stroke: '170.0',
  limit: '100',
  checkDate: '2026-10-04',
  ...over,
})

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`✓ ${name}`)
}

;(async () => {
  // 1. 提交校验五项读数 + 状态整笔写入；同日水情待办联动
  {
    const { gov, store, svc } = await loadApp()
    const before = store.listRows('hydrology').filter((r) => r.pending).length
    const res = await gov.submitGovernorCheck(1, payload(), 0)
    assert.strictEqual(res.ok, true, res.message)
    const row = gov.getGovernor(1)
    assert.strictEqual(String(row['油压值']), '2.55')
    assert.strictEqual(String(row['导叶开度']), '85')
    assert.strictEqual(String(row['接力器行程']), '170')
    assert.strictEqual(String(row['开度限位']), '100')
    assert.strictEqual(String(row['校验日期']), '2026-10-04')
    assert.strictEqual(row.status, '正常')
    assert.strictEqual(row.pending, false)
    assert.strictEqual(Number(row._rev), 1)
    const after = store.listRows('hydrology').filter((r) => r.pending).length
    assert.ok(res.linked >= 1, '同日至少联动一条水情')
    assert.strictEqual(after, before - res.linked)
    const hydro = store.listRows('hydrology').find((r) => String(r['观测时间']) === '2026-10-04')
    assert.strictEqual(hydro.status, '已调度')
    assert.ok(String(hydro['联动说明']).includes('GOVE-0001'))
    await test('整笔齐写五项读数与状态，同日水情待办联动销项', () => {})
  }

  // 2. 缺项校验整笔退回，不落半条
  {
    const { gov } = await loadApp()
    const bad = payload({ pressure: '' })
    const res = await gov.submitGovernorCheck(1, bad, 0)
    assert.strictEqual(res.ok, false)
    const row = gov.getGovernor(1)
    assert.strictEqual(String(row['油压值']), '')
    assert.strictEqual(row.status, '待校验')
    const bad2 = await gov.submitGovernorCheck(1, payload({ opening: '150' }), 0)
    assert.strictEqual(bad2.ok, false)
    await test('读数缺项/越界整笔退回，台账保持提交前原样', () => {})
  }

  // 3. 同一台连续两次提交只落最后一次
  {
    const { gov } = await loadApp()
    const r1 = await gov.submitGovernorCheck(1, payload(), 0)
    assert.strictEqual(r1.ok, true)
    const row1 = gov.getGovernor(1)
    const r2 = await gov.submitGovernorCheck(
      1,
      payload({ pressure: '2.60', opening: '88.0', stroke: '176.0', checkDate: '2026-10-05' }),
      Number(row1._rev),
    )
    assert.strictEqual(r2.ok, true, r2.message)
    const row2 = gov.getGovernor(1)
    assert.strictEqual(String(row2['油压值']), '2.6')
    assert.strictEqual(String(row2['导叶开度']), '88')
    assert.strictEqual(String(row2['校验日期']), '2026-10-05')
    assert.strictEqual(Number(row2._rev), 2)
    await test('同一台连续两次提交只落最后一次，无半条记录', () => {})
  }

  // 4. 同一份数据重复报送只算一次
  {
    const { gov } = await loadApp()
    const r1 = await gov.submitGovernorCheck(1, payload(), 0)
    assert.strictEqual(r1.ok, true)
    const rev = Number(gov.getGovernor(1)._rev)
    const r2 = await gov.submitGovernorCheck(1, payload({ pressure: '2.550' }), rev) // 数值等价
    assert.strictEqual(r2.ok, false)
    assert.ok(r2.message.includes('重复报送'))
    assert.strictEqual(Number(gov.getGovernor(1)._rev), rev)
    await test('同一份数据重复报送直接退回，版本不前进', () => {})
  }

  // 5. 并发提交只让第一笔生效
  {
    const { gov } = await loadApp()
    const [r1, r2] = await Promise.all([
      gov.submitGovernorCheck(1, payload(), 0),
      gov.submitGovernorCheck(1, payload({ pressure: '2.99' }), 0),
    ])
    const results = [r1, r2]
    const oks = results.filter((r) => r.ok)
    assert.strictEqual(oks.length, 1, '并发两笔只有一笔成功')
    const rejected = results.find((r) => !r.ok)
    assert.ok(rejected.message.includes('正在提交') || rejected.message.includes('旧数据'))
    const row = gov.getGovernor(1)
    assert.ok(['2.55', '2.99'].includes(String(row['油压值'])))
    assert.strictEqual(Number(row._rev), 1)
    await test('并发提交只让第一笔生效，后到整笔拒绝', () => {})
  }

  // 6. 乐观锁：基于旧数据的提交被拒
  {
    const { gov } = await loadApp()
    const r1 = await gov.submitGovernorCheck(1, payload(), 0)
    assert.strictEqual(r1.ok, true)
    const stale = await gov.submitGovernorCheck(1, payload({ pressure: '2.70' }), 0)
    assert.strictEqual(stale.ok, false)
    assert.ok(stale.message.includes('旧数据'))
    await test('基于旧版本的提交整笔拒绝写入', () => {})
  }

  // 7. 写库失败整套退回（调速器 + 水情都不动）
  {
    const { gov, store } = await loadApp()
    // 先触发一次读取完成迁移，再把提交通道封死，只拦截事务提交、不拦截初始化。
    void gov.governorStats()
    const origSetItem = globalThis.window.localStorage.setItem
    let failNextEntriesWrite = false
    globalThis.window.localStorage.setItem = (key, value) => {
      if (failNextEntriesWrite && key === 'hydropower-plant-om:entries') {
        throw new Error('配额已满')
      }
      return origSetItem.call(globalThis.window.localStorage, key, value)
    }
    failNextEntriesWrite = true
    const res = await gov.submitGovernorCheck(1, payload(), 0)
    globalThis.window.localStorage.setItem = origSetItem
    assert.strictEqual(res.ok, false)
    assert.ok(res.message.includes('退回'))
    const g = store.listRows('governor').find((r) => Number(r.id) === 1)
    assert.strictEqual(g.status, '待校验')
    const h = store.listRows('hydrology').find((r) => String(r['观测时间']) === '2026-10-04')
    assert.strictEqual(h.status, '已观测')
    await test('落库失败时调速器与水情整套退回', () => {})
  }

  // 8. 存量 v1 数据迁移：缺油压/行程按口径回填、补录台账、等级不改写、待校验清空
  {
    const v1 = {
      governor: [
        {
          id: 1, status: '待校验', pending: true, abnormal: false,
          装置编号: 'GOVE-OLD-1', 所属机组: '1号机组',
          油压值: '调速器样例1', 导叶开度: '调速器样例1', 接力器行程: '调速器样例1',
          开度限位: '调速器样例1', 校验日期: '2026-09-01', 装置状态: '调速器样例1',
        },
        {
          id: 2, status: '正常', pending: true, abnormal: false,
          装置编号: 'GOVE-OLD-2', 所属机组: '2号机组',
          油压值: '', 导叶开度: '78.0', 接力器行程: '',
          开度限位: '100', 校验日期: '2026-05-10', 装置状态: '正常',
        },
        {
          id: 3, status: '异常', pending: false, abnormal: false,
          装置编号: 'GOVE-OLD-3', 所属机组: '3号机组',
          油压值: '', 导叶开度: '', 接力器行程: '',
          开度限位: '', 校验日期: '', 装置状态: '异常',
        },
      ],
      hydrology: [
        {
          id: 1, status: '已观测', pending: false, abnormal: true,
          记录编号: 'H-1', 观测时间: '2026-09-02',
          上游水位: '水情调度样例2', 下游水位: '水情调度样例2', 入库流量: '水情调度样例2',
          出库流量: '水情调度样例2', 值守人员: '甲', 调度状态: '水情调度样例2',
        },
      ],
    }
    const { store } = await loadApp({ 'hydropower-plant-om:entries': JSON.stringify(v1) })
    const governors = store.listRows('governor')
    const pending = governors.find((r) => Number(r.id) === 1)
    assert.strictEqual(pending['油压值'], '')
    assert.strictEqual(pending['校验日期'], '')
    assert.strictEqual(pending['装置状态'], '待校验')
    const normal = governors.find((r) => Number(r.id) === 2)
    assert.strictEqual(String(normal['油压值']), '2.50')
    assert.strictEqual(String(normal['接力器行程']), '156.0') // 78 × 2
    assert.strictEqual(normal.status, '正常')
    assert.strictEqual(normal.pending, false)
    assert.strictEqual(normal._supplemented, true)
    const abnormal = governors.find((r) => Number(r.id) === 3)
    assert.strictEqual(abnormal.status, '异常') // 等级不改写
    assert.strictEqual(abnormal.abnormal, true)
    assert.ok(abnormal['校验日期'] !== '', '缺日期按时间顺序补排')
    assert.strictEqual(abnormal['油压值'], '2.50')
    const supplements = store.listSupplements()
    assert.ok(supplements.length >= 2)
    const s3 = supplements.filter((x) => x.governorId === 3)
    assert.ok(s3.some((x) => x.fields.includes('油压值')))
    assert.ok(supplements.every((x) => x.migratedAt !== ''))
    const hydro = store.listRows('hydrology')[0]
    assert.strictEqual(hydro['上游水位'], '')
    assert.strictEqual(hydro.pending, true)
    assert.strictEqual(hydro['调度状态'], '已观测')
    await test('v1 存量按日期回填缺项、补录单独成册、等级保留、占位清空', () => {})
  }

  // 9. 刷新（重新读 localStorage）后记录原样，两个入口同一份
  {
    const bundle = await loadApp()
    const r = await bundle.gov.submitGovernorCheck(1, payload(), 0)
    assert.strictEqual(r.ok, true)
    const persisted = JSON.parse(bundle.localStorage.getItem('hydropower-plant-om:entries'))
    const again = await loadApp(bundle.localStorage._dump())
    const rowFromStore = again.store.listRows('governor').find((x) => Number(x.id) === 1)
    const rowFromSvc = again.svc.listEntries('governor').items.find((x) => Number(x.id) === 1)
    const rowFromDomain = again.gov.getGovernor(1)
    for (const field of ['油压值', '导叶开度', '接力器行程', '开度限位', '校验日期']) {
      assert.strictEqual(String(rowFromStore[field]), String(persisted.governor[0][field]))
      assert.strictEqual(String(rowFromSvc[field]), String(rowFromStore[field]))
      assert.strictEqual(String(rowFromDomain[field]), String(rowFromStore[field]))
    }
    const stats = again.gov.governorStats()
    assert.strictEqual(stats.pending, 0)
    assert.strictEqual(stats.normal >= 1, true)
    await test('返回上一页再刷新记录原样，列表/详情/服务三个入口一致', () => {})
  }

  // 10. 导出明细与台账一致
  {
    const { gov, svc } = await loadApp()
    await gov.submitGovernorCheck(1, payload(), 0)
    const exported = svc.exportEntries('governor')
    assert.ok(exported.content.includes('2.55'))
    assert.ok(exported.content.includes('2026-10-04'))
    assert.ok(!exported.content.includes('联动')) // 内部列不进导出
    const row = gov.getGovernor(1)
    assert.ok(exported.content.includes(String(row['装置编号'])))
    await test('导出明细与页面台账读数完全一致', () => {})
  }

  // 11. 页脚待校验台数随提交变化
  {
    const { gov } = await loadApp()
    assert.strictEqual(gov.governorStats().pending, 1)
    await gov.submitGovernorCheck(1, payload(), 0)
    assert.strictEqual(gov.governorStats().pending, 0)
    await test('待校验装置台数随提交实时变化', () => {})
  }

  console.log(`\n全部 ${passed} 项校验通过`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
