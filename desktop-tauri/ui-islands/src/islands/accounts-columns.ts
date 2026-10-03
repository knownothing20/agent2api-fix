/**
 * 账号表的**列定义（列宽口径）+ 列宽拖拽**（替换 ui/accounts-columns.js 与
 * ui/accounts-table.js 的 COLUMNS 常量）。
 *
 * ── 与列设置（wbColSettings）的分工 ────────────────────────────
 * 这是**两套**互不相干的机制，别混：
 *   · 本文件管**宽度** —— 表头右缘的把手拖动改 `<col>` 的 inline width，存 localStorage；
 *   · wbColSettings 管**显隐与顺序**（还带对齐）—— 它就地重排既有 `th[data-col]` /
 *     `col[data-col]`，并把隐藏的列从 DOM 里摘掉。
 * 两套共用同一份列集合：`ACCOUNT_COLUMNS` 的 key（= CSS 类后缀 `.cell-<key>`）。
 *
 * 表格是 table-layout: fixed，列宽由 `<colgroup>` 的 `<col>` 决定 —— 拖动只改被拖的
 * 那一列的 style.width，其余列不动。默认宽度在 DEFAULTS 里与 page-accounts-table.css 的
 * `.cell-*` 类保持一致：没拖过的列不带 inline style、走 CSS；拖过（或还原过）之后以
 * 这里的值为准 —— 所以改 CSS 默认列宽时**两处要同步**（漂移的症状：用户双击把手
 * 「还原」后列宽跳到另一个值）。
 */

import type { Align } from './accounts-shared'

/** 列定义项（表头文案 / 小注 / 悬停说明 / 默认对齐 / 旧版默认对齐） */
export type AccountColumn = {
  key: string
  label: string
  /** 表头里的小字副标题（如「全局队列」「按模型」） */
  hint?: string
  /** 表头的悬停说明 */
  title?: string
  align: Align
  /** **上一版的默认对齐**，只被 table-col-settings 的 normalize 用来分辨旧存盘里那一档
   *  是「用户挑的」还是「旧默认值」—— 少了它，改过的默认对齐对老用户就不生效 */
  legacyAlign?: Align
}

/**
 * 列：勾选 / 优先级 / 提供商 / 账号 / 代理 / 连接数 / 状态 / 限流 / 有效期 / 余额 / 操作。
 *
 * 优先级是整张表的主线（全局队列），所以放在提供商之前、紧跟勾选列。
 * 连接数紧跟账号列：它回答的是「这个账号此刻有几个请求在跑」，属于**账号的身份**
 * 而非健康状态 —— 放在状态列之前，与状态列（可用性）分工清楚。
 * 代理列紧挨账号列：它读起来是账号的属性，与后面的运行时读数不是一类。
 *
 * `key` 同时是 CSS 类名后缀（`cell-<key>`），默认列宽在 page-accounts-table.css 里按
 * 这些类名声明 —— 键名只有这一处定义。
 *
 * 勾选列的 label 给「选择」而不是空串：它在表格里确实没有表头文案（那一格是「全选」
 * 复选框），但列设置面板里必须有个名字 —— 面板按 label 显示，空串会退化成原始 key。
 *
 * 默认对齐：操作列居右（贴住表格右缘时整列有一条整齐的竖线），其余全部居中
 * （格子里装的是徽章 / 开关 / 序号 / 读数这类等宽或很短的内容，居中后同一列各行对齐
 * 到一条中轴，比左对齐更好扫读）。legacyAlign 只写在「上一版默认与新版不同」的列上。
 */
export const ACCOUNT_COLUMNS: AccountColumn[] = [
  { key: 'pick', label: '选择', align: 'center', legacyAlign: 'left' },
  {
    key: 'priority', label: '优先级', hint: '全局队列',
    title: '全局一条队列：数值越小越先用，不分提供商',
    align: 'center', legacyAlign: 'left',
  },
  { key: 'provider', label: '提供商', align: 'center', legacyAlign: 'left' },
  { key: 'account', label: '账号', align: 'center', legacyAlign: 'left' },
  {
    key: 'proxy', label: '代理',
    title: '该账号出网走的代理（Clash 出口 / 自定义 / 直连）；点击可修改',
    align: 'center',
  },
  {
    key: 'connections', label: '连接数',
    title: '此刻正在使用这个账号的请求数（含还在下发内容的流式请求）；为 0 时不显示',
    align: 'center',
  },
  { key: 'status', label: '状态', align: 'center', legacyAlign: 'left' },
  {
    key: 'limits', label: '限流', hint: '按模型',
    title: '该账号当前限流中的模型；点徽章看明细',
    align: 'center', legacyAlign: 'left',
  },
  { key: 'expiry', label: '有效期', align: 'center', legacyAlign: 'left' },
  // 「余额」列只放读数（查询按钮在操作列）：一个只显示余额数字的列叫「余额 / 积分」
  // 会让人以为这里还能点。而「余额」这个词也容得下各家的不同叫法（积分 / 余额）
  { key: 'usage', label: '余额', align: 'center', legacyAlign: 'left' },
  { key: 'actions', label: '操作', align: 'right' },
]

/** 优先级号段（与后端 priority.rs 的 MIN/MAX/DEFAULT 逐字一致） */
export const PRIORITY_MIN = 0
export const PRIORITY_MAX = 9999
export const PRIORITY_DEFAULT = 100

/** 优先级归一：夹到号段内并取整 */
export function clampPriority(value: number): number {
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.round(value)))
}

/** 账号的优先级值（缺失 / 非法按默认值） */
export function priorityOf(account: { priority?: number } | null | undefined): number {
  const value = Number(account?.priority)
  return Number.isFinite(value) ? value : PRIORITY_DEFAULT
}

/* ─── 列宽 ─────────────────────────────────── */

const STORE_KEY = 'agent2api-accounts-col-widths'

/**
 * 默认列宽（px）：与 page-accounts-table.css 的 `.cell-*` 一一对应。
 *
 * 改这里**必须**同时改 CSS 与那份文件头的列宽预算说明 —— 三处是同一组数字。
 * 预算：十个固定列合计 1193px（勾选 47 / 优先级 132 / 提供商 132 / 代理 186 /
 * 连接数 56 / 状态 80 / 限流 148 / 有效期 80 / 余额 132 / 操作 200），账号列吃掉剩余宽度。
 * 代理列 186 是「节点名 :端口」的常见形态 + 选择器自带的约 41px 固定开销；
 * 余额列 132 是「主额度桶两行形态」的最小值（套餐名一行要放得下
 * 「ZCode Trust Build」，被省略号砍成「ZCode Tr…」这一列就白给了）；
 * 操作列 200 是四颗按钮并排的最坏情况（「已签到 / 余额 / 设置 / ⋯」），
 * 改按钮文案或增删按钮时重算一遍。
 */
const DEFAULTS: Record<string, number> = {
  pick: 47,
  priority: 132,
  provider: 132,
  account: 300,
  proxy: 186,
  connections: 56,
  status: 80,
  limits: 148,
  expiry: 80,
  usage: 132,
  actions: 200,
}

/** 拖动的下限：再窄就该点不准里面的控件了 */
const MIN_WIDTH = 56

/** 用户改过的列宽（只有与默认不同的列才会有值），启动时从 localStorage 恢复 */
const overrides: Record<string, number> = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, unknown>
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(raw || {})) {
      const width = Number(value)
      if (DEFAULTS[key] && Number.isFinite(width) && width >= MIN_WIDTH) clean[key] = Math.round(width)
    }
    return clean
  } catch {
    return {}
  }
})()

function persist(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(overrides))
  } catch { /* 隐私模式等存不了就算了：本次会话内仍然生效 */ }
}

/** 渲染时的列宽表：默认值 + 用户覆盖（每个 key 都有值，colgroup 一次写全） */
export function columnWidths(): Record<string, number> {
  const map: Record<string, number> = {}
  for (const [key, width] of Object.entries(DEFAULTS)) {
    map[key] = overrides[key] ?? width
  }
  return map
}

/**
 * 第 index 个表头格对应的「列 key + 它的 `<col>`」。
 *
 * 列设置能藏列、能换顺序，所以**不能**只按位置认列：位置只是拿表头格用的，真正的
 * 身份是 `data-col`（表头 th 与 colgroup 的 col 上同名），拿到 key 之后再按 key 找
 * 那个 `<col>` —— 两处口径一致，用户拖过顺序之后也不会把宽度写到别的列上。
 */
function columnAt(table: Element | null, index: number): { key: string; col: Element } | null {
  const header = table?.querySelector(`thead th:nth-child(${index + 1})`)
  const key = header?.getAttribute('data-col') || header?.className.match(/cell-([a-z]+)/)?.[1]
  if (!key) return null
  const col = table?.querySelector(`colgroup col[data-col="${CSS.escape(key)}"]`)
    || table?.querySelectorAll('colgroup col')[index]
  return col ? { key, col } : null
}

/** 把一次宽度落进 `<col>`（拖动中实时调用的就是它） */
function applyWidth(col: Element, key: string, px: number): void {
  const width = Math.max(MIN_WIDTH, Math.round(px))
  ;(col as HTMLElement).style.width = width + 'px'
  if (DEFAULTS[key] && width !== DEFAULTS[key]) overrides[key] = width
  else delete overrides[key]
}

/** 列宽改动后请视图重绘（colgroup 由 widths() 统一生成，重绘让 DOM 与持久化状态对齐） */
let repaint = (): void => {}

/**
 * 委托绑定：pointerdown 开拖、dblclick 还原。挂在滚动容器上一次即可，
 * 表格被整表重绘后监听仍然有效（委托到容器，不依赖具体节点）。
 *
 * 与 table-columns.js 同一套写法（指针事件 + setPointerCapture + 两道收尾兜底）：
 * 松手若被浏览器丢掉（指针拖出窗口再松），拖动就永远不结束，鼠标一动列宽就跟着走。
 */
export function bindColumnGrips(host: HTMLElement | null, onChange: () => void): void {
  repaint = onChange
  if (!host) return
  let dragging: { col: Element; key: string; startX: number; startWidth: number; grip: Element; pointerId: number } | null = null

  host.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    const grip = (event.target as Element | null)?.closest?.('.col-grip')
    if (!grip) return
    event.preventDefault()
    const th = grip.closest('th')
    const table = th?.closest('table') || null
    const index = th?.parentElement ? [...th.parentElement.children].indexOf(th) : -1
    const column = columnAt(table, index)
    if (!column) return
    const startX = event.clientX
    const startWidth = column.col.getBoundingClientRect().width
    grip.classList.add('active')
    document.body.classList.add('col-resizing')
    try { (grip as Element & { setPointerCapture(id: number): void }).setPointerCapture(event.pointerId) } catch { /* 退回全局监听 */ }
    dragging = { ...column, startX, startWidth, grip, pointerId: event.pointerId }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)

    function move(moveEvent: PointerEvent): void {
      if (!dragging) return
      if (moveEvent.buttons === 0) { up(); return }
      applyWidth(dragging.col, dragging.key, dragging.startWidth + moveEvent.clientX - dragging.startX)
    }

    function up(): void {
      if (!dragging) return
      const { grip: activeGrip, pointerId } = dragging
      dragging = null
      activeGrip.classList.remove('active')
      document.body.classList.remove('col-resizing')
      try { (activeGrip as Element & { releasePointerCapture(id: number): void }).releasePointerCapture(pointerId) } catch { /* 已自动释放 */ }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
      persist()
      repaint()
    }
  })

  host.addEventListener('dblclick', event => {
    const grip = (event.target as Element | null)?.closest?.('.col-grip')
    if (!grip) return
    const th = grip.closest('th')
    const table = th?.closest('table') || null
    const index = th?.parentElement ? [...th.parentElement.children].indexOf(th) : -1
    const column = columnAt(table, index)
    if (!column) return
    delete overrides[column.key]
    persist()
    repaint()
  })
}
