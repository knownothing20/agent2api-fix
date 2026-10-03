/**
 * Agent2API · 账号页（四家混排的一张表 + 批量栏 + 两个弹窗）—— React 岛。
 *
 * 替换 ui/accounts-table.js + ui/accounts-view.js + ui/accounts-filters.js +
 * ui/accounts-columns.js + ui/accounts-groups.js + ui/accounts-model.js +
 * ui/usage-actions.js + ui/account-panel.js + ui/proxy-form.js 九个文件。
 * 本文件只放**页面骨架与挂载**：行与单元格在 accounts-panels.tsx，两个弹窗在
 * accounts-dialogs.tsx，状态与动作在 accounts-data.ts，纯逻辑在 accounts-domain.ts。
 *
 * ── 对外契约（必须原样保留，调用点逐个 grep 确认过）─────────────
 *   · `window.wbAccountsView` —— app.js:147 syncConnections / app.js:575 render /
 *     app.js:622 refreshCaches / app.js:811 与 tasks-panel.tsx:559 syncBalancesSnapshot /
 *     providers.js:138 render
 *   · `window.wbAccountsModel` —— app.js:178 isRateLimited / app.js:663 isDesktopAccount /
 *     report.js:307 editionSuffix / models-fetch-modal.tsx:245 providerFeatures、
 *     :255 byPriorityOrder
 *   · `window.wbAccountPanel` —— app.js:623 invalidate / app.js:645 open
 * 注册都在 accounts-data.ts 的 installAccountsApi()（模块求值即完成）。
 *
 * ── 静态表头（本页最容易出错的地方）────────────────────
 * `<colgroup>` 的 `col[data-col]` 与 `<thead>` 的 `th[data-col]`（见 accounts-panels.tsx
 * 的 TableHead）是**字面量**渲染，永远按 index.html 的原始顺序渲染全部 11 列、且不随任何
 * 状态变化：列的显隐与顺序靠 `wbColSettings.syncStaticHead` **就地重排既有元素**
 * （隐藏的列是从 DOM 里摘掉而不是 display:none），不能按状态重建 —— `<col>` 上带着列宽
 * 拖拽写进去的 inline 宽度，`<th>` 里插着列宽把手，重建会把两者一起丢掉。React 只在
 * 「同一位置、同一类型的子节点」上做属性 diff，这些节点的 props 与文本逐字不变，
 * 重渲染时一次 DOM 写都不会发生。数据行（tbody）相反：完全按 visibleColumns() 逐列渲染。
 *
 * ── 列宽（accounts-columns）与列设置（wbColSettings）是两套 ──────
 * 前者管宽度（拖表头右缘的把手），后者管显隐 / 顺序 / 对齐。列的集合只有一份
 * （accounts-columns.ts 的 ACCOUNT_COLUMNS），两套都按 `data-col` 认列。
 *
 * ── 挂载必须**同步**（flushSync）───────────────────────────
 * 账号页的「添加账号」按钮（`#btn-add-account-2`）由 ui/add-account.js:196 用
 * `$('btn-add-account-2').addEventListener(...)` **非可选链**地绑定，而那个脚本排在
 * islands/ui.js 之后、同步执行。React 的首次渲染默认是异步的（走 Scheduler 的宏任务），
 * 那时按钮还不存在 → 那一行会抛 TypeError，把 add-account.js 后面所有监听一起带崩。
 * 所以首次挂载用 flushSync 强制同步提交（DOM 与布局 effect 都落地），后续更新照常异步。
 *
 * ── 隐藏优先条件渲染 ───────────────────────────────────────
 * 组件库的工具类是**分层 + !important** 的，tokens.css 的 `[hidden] { display:none
 * !important }` 未分层；按 Cascade 5，important 的层序反转 —— 分层压过未分层。
 * 组件库 globals.css 已补同层的 `[hidden][hidden]` 兜底，属性式显隐因此可用；
 * 但能条件渲染就条件渲染（少一批常驻 DOM），属性式留给「节点必须常驻」的场合
 * （登录引擎的段落与取消按钮，见 add-provider-blocks.tsx）。
 */

import * as React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import {
  Button,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SegmentedControl,
  cn,
} from '@ui'
import { TableFooter, useClientPaging } from './table-shell'
import { shared, type AccountRecord, type ColSettingsHandle } from './accounts-shared'
import { checkinableAccounts, isDesktopAccount, isEnabled, supportsUsage } from './accounts-domain'
import { ACCOUNT_COLUMNS, bindColumnGrips, columnWidths } from './accounts-columns'
import {
  allAccounts, checkinAll, clearLimits, clearSelection, ensureProxyPoolOptions,
  getStore, installAccountsApi, normalizeFilter, openBatchDialog, panelOpen, providerSummaryList,
  queryAllUsage, rowContext, seats, segmentCounts, setAllPicked, setProviderFilter, setSegmentFilter,
  snapshot, startConnectionsPolling, subscribe, togglePick, visibleList,
} from './accounts-data'
import {
  AccountCell, ActionsCell, ConnectionsCell, ExpiryCell, LimitsCell, PanelsRow, PriorityStepper,
  ProviderCell, ProxyCell, StatusCell, TableHead, UsageCell,
} from './accounts-panels'
import { AccountsDialogs } from './accounts-dialogs'

/** 列设置的句柄（注册在挂载后的布局 effect 里，见下方说明） */
let colHandle: ColSettingsHandle | null = null
/** 列设置是否已经登记过（登记只做一次：它是全局注册表，重复登记会插出第二颗齿轮） */
let colSettingsRegistered = false
/**
 * 登记的重试定时器。
 *
 * 为什么需要重试：本岛的首帧是 `flushSync` 同步提交的（为了让 add-account-modal 在
 * **模块求值期**就能查到「添加账号」那颗按钮），而布局 effect 就挂在那次同步提交上 ——
 * 那一刻本模块还排在 `table-col-settings.tsx` 前面，`window.wbColSettings` 尚未挂上，
 * 一次性登记会静默落空、齿轮永远不出现（旧实现是加载期注册，没有这个时序问题）。
 * 所以拿不到就隔一拍再试，直到组件卸载。
 */
let colSettingsRetry = 0
/** 表格元素（静态表头的就地重排要用它；由 <table ref> 写入） */
let tableEl: HTMLTableElement | null = null
/** 表头已经同步过的「表格在不在 + 可见列与对齐」签名：只有它变了才重排表头（见 syncHead） */
let headSignature = ''

/** 当前可见列（顺序即配置顺序；列设置未就绪时退回全部列） */
function visibleColumns(): Array<(typeof ACCOUNT_COLUMNS)[number] & { align: 'left' | 'center' | 'right' }> {
  return colHandle ? colHandle.apply(ACCOUNT_COLUMNS) : ACCOUNT_COLUMNS
}

/** 触发一次重绘（store 换快照 → 订阅者重画） */
function requestRender(): void {
  window.wbAccountsView?.render?.()
}

/**
 * 表头就地重排（顺序 / 显隐 / 对齐）+ 把列宽把手挪到「不是最后一列」的格子上。
 *
 * 签名比对是必需的：这个方法要在**每次**提交后检查（注册完成、加载完成、配置变化都
 * 会改签名），而 `syncStaticHead` 内部是 `appendChild` 逐列移动既有元素 —— 无谓地每
 * 2 秒（连接数轮询）重排一次会不断产生 DOM 变动记录。
 */
function syncHead(): void {
  const columns = visibleColumns()
  const signature = `${tableEl ? 'T' : 'F'}|${columns.map(column => `${column.key}:${column.align}`).join('|')}`
  if (signature === headSignature) return
  headSignature = signature
  shared().wbColSettings?.syncStaticHead('accounts', tableEl)
  // 把手要放在「不是最后一列」的格子上：它绝对定位在右缘（right: -4px），钉在表格
  // 右缘会顶出一条横向滚动条。「哪一列在最后」是用户配置出来的，所以按渲染后的位置判。
  const ths = [...(tableEl?.querySelectorAll('thead th') || [])]
  ths.forEach((th, index) => {
    const grip = th.querySelector('.col-grip') as HTMLElement | null
    if (grip) grip.style.display = index === ths.length - 1 ? 'none' : ''
  })
}

/* ─── 页面 ─────────────────────────────────── */

function AccountsPage() {
  const store = React.useSyncExternalStore(subscribe, getStore)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  /** 登记列设置之后强制重画一次用的本地计数器（不依赖 store 订阅的时序，见下） */
  const [, forceTick] = React.useReducer((tick: number) => tick + 1, 0)

  const loaded = Boolean(snapshot())
  const all = allAccounts()
  const summaries = providerSummaryList()
  const counts = segmentCounts()
  const visible = visibleList()
  const seatMap = seats()
  const columns = visibleColumns()
  /**
   * 客户端分页（通用表格外壳）：账号是**全局优先级队列**，行序本身就是数据，
   * 所以默认给「全部」这一档 —— 想分页的用户可以在页脚自己换档位。
   *
   * 勾选按 id 存在 store 里，翻页不会丢选择；但「批量操作」作用于**全部已勾选**
   * 的账号（含被分页挡在别的页上的），这一点与「被筛选隐藏的也参与操作」同一口径，
   * 页脚的读数只描述当前页。
   */
  const paging = useClientPaging(visible.length, 'accounts', { defaultSize: 'all' })
  const pageRows = paging.paged ? paging.slice(visible) : visible

  // 归一化与自愈都放在 effect 里（渲染期改状态会与 React 的渲染顺序打架）：
  //   · 摘要里已不存在的 provider（账号被删光）复位成「全部」；
  //   · 代理列的选项（「网络代理」页的池条目）没就绪就补拉（节流 30 秒，
  //     失败不缓存）。Clash 出口那一组已经不在这一页了 —— 出口统一由代理
  //     页的「同步 Clash Verge」导入池，这里只读池（见 accounts-panels 的 ProxyCell）
  React.useEffect(() => { normalizeFilter() }, [store.version])
  React.useEffect(() => { ensureProxyPoolOptions() })

  // 列设置的注册必须在挂载后：按钮要插进本岛渲染出来的 `.batch-actions`，而
  // syncStaticHead 要求登记表已存在（它按 id 查配置）。用布局 effect 是为了让首屏的
  // 表头重排与按钮插入都赶在后续同步脚本之前完成（首次提交本身是 flushSync 的）。
  //
  // 登记完要立刻重画一次（forceTick，而不是等 store 的订阅回调 —— 那个订阅装在被动
  // effect 里，首屏这一刻还没生效）：登记之前那一次渲染读的是「全列」兜底值，用户存过的
  // 显隐 / 顺序必须在首屏就落到表头与数据行上（旧实现在加载期注册，所以首屏天然是对的）。
  React.useLayoutEffect(() => {
    if (!colSettingsRegistered) {
      // wbColSettings 还没挂上（本模块在 glob 里排在它前面，而首帧是同步提交的）：
      // 隔一拍再试，别把这次落空当成「登记过了」
      if (!shared().wbColSettings?.register) {
        window.clearTimeout(colSettingsRetry)
        colSettingsRetry = window.setTimeout(() => setRetryTick(tick => tick + 1), 50)
        return
      }
      colSettingsRegistered = true
      colHandle = shared().wbColSettings?.register({
        id: 'accounts',
        label: '账号表',
        columns: ACCOUNT_COLUMNS.map(column => ({
          key: column.key,
          label: column.label,
          align: column.align,
          legacyAlign: column.legacyAlign,
        })),
        // 挂载点是批量栏右侧的操作组（「批量操作 / 取消选择」那两颗）：齿轮插在最前，
        // 正好落在「批量操作」左边（列设置是「怎么看这张表」，与旁边那些「对数据做什么」
        // 的操作按钮不是一类，排头更顺）
        mount: () => document.querySelector('#batch-bar .batch-actions'),
        onChange: requestRender,
      }) || null
      if (colHandle) forceTick()
      return
    }
    syncHead()
  })
  // 登记重试的驱动：定时器到点改一次这个计数，让上面的布局 effect 再跑一遍
  const [, setRetryTick] = React.useState(0)
  React.useEffect(() => () => window.clearTimeout(colSettingsRetry), [])

  // 列宽拖拽（pointerdown 开拖 / dblclick 还原）委托在滚动容器上一次即可：
  // 表格被整表重建后监听仍然有效（委托到容器，不依赖具体节点）
  React.useEffect(() => {
    bindColumnGrips(listRef.current, requestRender)
  }, [])

  const visibleIds = visible.map(account => account.id)
  const allPicked = visibleIds.length > 0 && visibleIds.every(id => store.selected.has(id))
  const somePicked = visibleIds.some(id => store.selected.has(id))
  /** 被筛选隐藏但仍在勾选中的账号：操作会作用于它们，所以必须显式提示，不能静默生效 */
  const hiddenByFilter = [...store.selected].filter(id => !visibleIds.includes(id)).length
  const active = store.selected.size > 0

  /** 单元格：按列 key 分发（勾选列的内容依赖行上下文，其余列是「账号 + 上下文」的纯函数） */
  function cell(key: string, account: AccountRecord, ctx: ReturnType<typeof rowContext>) {
    switch (key) {
      case 'pick':
        return (
          <Checkbox checked={ctx.picked} data-pick={account.id} title='勾选后可批量操作'
            aria-label='勾选后可批量操作'
            onCheckedChange={next => togglePick(account.id, next)} />
        )
      case 'priority':
        return <PriorityStepper account={account} seat={ctx.seat} />
      case 'provider':
        return <ProviderCell account={account} />
      case 'account':
        return <AccountCell account={account} namesHidden={store.namesHidden} />
      case 'proxy':
        return <ProxyCell account={account} />
      case 'connections':
        return <ConnectionsCell account={account} />
      case 'status':
        return <StatusCell account={account} />
      case 'limits':
        return <LimitsCell account={account} open={ctx.limitsOpen} />
      case 'expiry':
        return <ExpiryCell account={account} />
      case 'usage':
        return <UsageCell account={account} />
      case 'actions':
        return <ActionsCell account={account} atFront={ctx.seat.position <= 1} />
      default:
        return null
    }
  }

  const providerOptions = [{ value: 'all', label: `全部（${all.length}）` }]
    .concat(summaries.map(item => ({ value: item.id, label: `${item.label}（${item.count}）` })))

  return (
    <>
      <section className='panel account-table'>
        <div className='toolbar'>
          {/* 提供商维度用下拉而不是分段按钮：家数是**动态**的（后端注册表加一家就多一项），
              分段按钮会随家数增长把工具条挤成一团；选项里带账号数，于是「哪家有账号、
              各有多少」不用切页就能看到 */}
          <div className='group' data-provider-group='1'>
            <span className='label'>提供商</span>
            <Select value={store.filter.provider} onValueChange={value => setProviderFilter(String(value))}>
              <SelectTrigger className='max-w-[200px] min-w-[130px]' aria-label='按提供商筛选账号'>
                <SelectValue>
                  {providerOptions.find(item => item.value === store.filter.provider)?.label || '全部'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map(item => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='divider' data-provider-divider='1' />

          <div className='group'>
            <span className='label'>状态</span>
            {/* 两个筛选维度是**受控**的（取值与计数都以 store 为准），限流组在状态筛成
                「禁用」时置灰 —— 已禁用账号既不算正常也不算已限流 */}
            <SegmentedControl options={[
              { value: 'all', label: '全部', count: counts.enabledAll ?? 0 },
              { value: 'enabled', label: '启用', count: counts.enabled ?? 0 },
              { value: 'disabled', label: '禁用', count: counts.disabled ?? 0 },
            ]} value={store.filter.enabled} onValueChange={value => setSegmentFilter('enabled', value)}
              aria-label='启用状态' />
          </div>

          <div className='group'>
            <span className='label'>限额</span>
            <SegmentedControl options={[
              { value: 'all', label: '全部', count: counts.limitAll ?? 0 },
              { value: 'normal', label: '正常', count: counts.normal ?? 0, disabled: store.filter.enabled === 'disabled' },
              { value: 'limited', label: '已限流', count: counts.limited ?? 0, disabled: store.filter.enabled === 'disabled' },
            ]} value={store.filter.limit} onValueChange={value => setSegmentFilter('limit', value)}
              aria-label='限额状态' />
          </div>

          <div className='actions'>
            {/* 「添加账号」的打开逻辑归 add-account.js（它按同一个 id 绑了监听），这里再挂
                一次 onClick 是**冗余保险**：万一那个脚本的绑定因加载顺序没接上，按钮仍可用
                （openModal / resetAddStep 都是幂等的，重复调用无副作用） */}
            <Button id='btn-add-account-2' variant='default' title='登录 / 导入一个新账号'
              onClick={() => {
                shared().wbAddAccountModal?.open?.()
                shared().wbAccountAddForms?.syncAddProvider?.()
              }}>添加账号</Button>
            <Button id='btn-query-usage' variant='outline'
              disabled={store.usageBusy || !all.some(supportsUsage)}
              title='查询全部启用账号的余额'
              onClick={() => void queryAllUsage()}>{store.usageBusy ? '查询中…' : '查询余额'}</Button>
            <Button id='btn-checkin-all' variant='outline'
              disabled={store.checkinBusy || !checkinableAccounts(all).length}
              title='为全部可签到的账号串行签到'
              onClick={() => void checkinAll()}>{store.checkinBusy ? '签到中…' : '全部签到'}</Button>
          </div>
        </div>

        <div className={cn('batch-bar', active && 'active')} id='batch-bar'>
          <label className='batch-select-all'>
            <Checkbox id='batch-select-all' checked={allPicked} indeterminate={!allPicked && somePicked}
              disabled={!visibleIds.length} aria-label='全选当前筛选结果'
              onCheckedChange={next => setAllPicked(visibleIds, next)} />
            <span id='batch-select-label'>
              {visibleIds.length ? `全选当前筛选结果（${visibleIds.length} 个）` : '没有可全选的账号'}
            </span>
          </label>
          <span className='batch-count'>
            已选 <b id='batch-count'>{store.selected.size}</b> 个 · 共 <b id='accounts-count'>{all.length}</b> 个
          </span>
          {/* 摘要只列**有账号**的家：这一段回答的是「账号分别落在谁家」，而「Cline Pass 0」
              这类只占宽度、不提供信息。完整清单仍在下拉里，含 0 的家，筛选口径不变 */}
          <span className='provider-summary' id='accounts-provider-summary'>
            {summaries.filter(item => item.count > 0).map(item => `${item.label} ${item.count}`).join(' · ')}
          </span>
          {hiddenByFilter ? (
            <span className='batch-hidden' id='batch-hidden-hint'>
              另有 {hiddenByFilter} 个已勾选账号被当前筛选隐藏，仍会参与操作
            </span>
          ) : null}
          <div className='batch-actions'>
            {/* 「列设置」按钮由 wbColSettings.register 插进这个容器的最前面（命令式，
                插入位置由那边决定，本岛只留容器） */}
            <Button id='btn-batch-open' variant='outline' disabled={!active}
              onClick={() => openBatchDialog([...store.selected], 'enable')}>批量操作</Button>
            <Button id='btn-batch-clear' variant='outline' disabled={!active}
              onClick={() => clearSelection()}>取消选择</Button>
          </div>
        </div>

        <div className='acct-scroll' id='account-list' ref={listRef}>
          {!loaded ? (
            <div className='empty'><span className='spinner' />正在加载…</div>
          ) : !all.length ? (
            <div className='empty'>暂无账号，请点击右上角「添加账号」</div>
          ) : !visible.length ? (
            <div className='empty'>当前筛选条件下没有账号</div>
          ) : (
            <table className='acct-table' ref={setTableElement}>
              <ColGroup />
              <TableHead namesHidden={store.namesHidden} allPicked={allPicked} somePicked={somePicked}
                disabled={!visibleIds.length} onToggleAll={next => setAllPicked(visibleIds, next)} />
              <tbody>
                {pageRows.map(account => {
                  const ctx = rowContext(account, seatMap)
                  return (
                    <React.Fragment key={account.id}>
                      <tr className={cn('acct-row', !isEnabled(account) && 'disabled', ctx.picked && 'selected')}
                        data-id={account.id} data-desktop={isDesktopAccount(account) ? '1' : undefined}>
                        {columns.map(column => (
                          <td key={column.key} className={`cell-${column.key} ta-${column.align}`}>
                            {cell(column.key, account, ctx)}
                          </td>
                        ))}
                      </tr>
                      <PanelsRow account={account} colSpan={columns.length}
                        limitsOpen={panelOpen(account.id, 'limits')}
                        onClear={(id, model) => void clearLimits(id, model)} />
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 页脚是纯控制条（读数 / 每页条数 / 跳页 / 翻页器，通用件 table-shell.tsx）。
            左侧原先那两句说明（优先级是全局队列 / 拖表头调列宽 / 设为首选的含义）
            按用户要求移除 —— 五张表的页脚现在都不带说明文字了。 */}
        <TableFooter
          total={visible.length}
          range={paging.paged ? { start: paging.rangeStart, end: paging.rangeEnd } : null}
          page={paging.page}
          pageCount={paging.pageCount}
          size={paging.size}
          onSizeChange={paging.setSize}
          onPageChange={paging.goto}
        />
      </section>
      <AccountsDialogs />
    </>
  )
}

/** 表格元素写进模块变量（供 syncStaticHead 用）。用模块级函数做 ref 回调，
    身份稳定 —— 内联箭头函数会在每次重渲染时先卸下再装上，白白多一轮空窗 */
function setTableElement(el: HTMLTableElement | null): void {
  tableEl = el
}

/** 列宽骨架（colgroup）：11 列的字面量顺序，`data-col` 与表头、列设置、列宽层三处同名 */
function ColGroup() {
  const widths = columnWidths()
  const col = (key: string) => (
    <col key={key} data-col={key} style={widths[key] ? { width: `${widths[key]}px` } : undefined} />
  )
  return (
    <colgroup>
      {col('pick')}
      {col('priority')}
      {col('provider')}
      {col('account')}
      {col('proxy')}
      {col('connections')}
      {col('status')}
      {col('limits')}
      {col('expiry')}
      {col('usage')}
      {col('actions')}
    </colgroup>
  )
}

/* ─── 挂载：接管 index.html 里既有的页面区块 ─────── */

const PAGE_SELECTOR = '.page[data-page="accounts"]'

let root: ReturnType<typeof createRoot> | null = null

/**
 * 把 React root 直接建在 `.page[data-page="accounts"]` 上（不套宿主 div：页面 CSS 用
 * `.page[data-page="accounts"] .panel` 这组直接子选择器分配高度，中间插一层会打断它）。
 *
 * **首次提交必须是同步的**（flushSync，理由见文件头）：后续更新照常异步。
 */
function mount(): void {
  if (root) return
  const section = document.querySelector<HTMLElement>(PAGE_SELECTOR)
  if (!section) return
  section.replaceChildren()
  root = createRoot(section)
  flushSync(() => { root!.render(<AccountsPage />) })
}

// 对外契约与连接数轮询都在模块求值时完成（app.js 的 refresh() 是异步的，但
// report.js / add-account.js 这些同步脚本紧随其后执行 —— 拿不到就会退化成静默不生效）
installAccountsApi()
startConnectionsPolling()

// 脚本排在页面骨架之后（index.html 里 islands/ui.js 在各 section 之后），正常直接挂；
// 万一将来被挪到前面，退化成等 DOM 解析完再挂。
if (document.querySelector(PAGE_SELECTOR)) mount()
else document.addEventListener('DOMContentLoaded', mount, { once: true })
