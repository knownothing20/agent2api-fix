/**
 * 账号页的**状态 store**（非岛：`.ts` 不被 import.meta.glob 当岛加载）：快照、筛选、
 * 勾选、行内面板展开态、账号名隐藏、以及从快照派生的各种读法。
 *
 * ── 从 accounts-data.ts 拆出来的理由 ──────────────────────────
 * 「状态怎么存」与「动作怎么发」是两件事，混在一个文件里已经九百多行（约定单文件 ≤800）。
 * 拆开之后：本文件只回答「现在是什么状态、怎么改」，actions（余额 / 签到 / 连接数 /
 * Clash 缓存 / 行内动作 / 弹窗 / 对外契约）在 accounts-data.ts —— 那个文件再
 * `export * from './accounts-store'`，于是视图侧的 import 路径一行不用改。
 *
 * ── 为什么是模块级 store + useSyncExternalStore ────────────────
 * 对外契约（`wbAccountsView.render()` / `refreshCaches()` / `syncConnections()` /
 * `syncBalancesSnapshot()`）从 React 之外调用，且必须与界面共用同一份状态 ——
 * 组件内部的 useState 做不到这一点。所以状态是一份模块级快照，改动一律走 patch()
 * （换新对象再通知订阅者）。
 *
 * ── 两种持有方式（刻意不同）──────────────────────────────
 *   · 高频小改动（连接数每 2 秒一轮）走 `patch({...})` 换新 Map / Set；
 *   · 少量原地可变的结构由各自的动作层维护（见 accounts-data.ts 的说明）。
 * 两条路都经过同一个订阅者集合，React 侧看不出差别。
 */

import { shared, type AccountRecord, type AccountsSnapshot, type ClashSnapshot, type PanelKind } from './accounts-shared'
import {
  byPriorityOrder, filterCounts, positionMap, providerSummaries, visibleAccounts,
  type AccountFilter,
} from './accounts-domain'

/** 弹窗状态：账号设置（单个）/ 批量操作（多选 + 动作），关闭即 null */
export type AccountsDialog =
  | { kind: 'settings'; id: string }
  | { kind: 'batch'; ids: string[]; action: string }
  | null

export type AccountsStore = {
  /** 每次变更 +1；React 靠它判断「该重画了」（快照对象同时被换掉） */
  version: number
  filter: AccountFilter
  selected: ReadonlySet<string>
  panels: ReadonlyMap<string, ReadonlySet<PanelKind>>
  connections: ReadonlyMap<string, number>
  /** Clash 出口列表缓存（`null` = 还没读到）；**只有代理表单的 Clash 直引档用**
   *  （存量配置专用）—— 账号页的代理下拉列的是「网络代理」页的池条目 */
  clash: ClashSnapshot | null
  dialog: AccountsDialog
  namesHidden: boolean
  /** 批量查询余额 / 签到在途（工具条按钮的文案与禁用态） */
  usageBusy: boolean
  checkinBusy: boolean
  /** 余额查询在途的账号（行上那颗「余额」按钮的去重闸） */
  usageInflight: ReadonlySet<string>
}

/* ─── 跨次启动的记忆键 ───────────────────────── */

const FILTERS_KEY = 'workbuddy-desktop-accounts-filters'
/** 账号名隐藏开关（表头「账号」旁边那颗眼睛）：打开后账号列的名字整体显示成星号。
 *  这是「怎么看这张表」的偏好，与列宽同一档，存 localStorage 跨次启动保留 */
const NAMES_HIDDEN_KEY = 'workbuddy-desktop-accounts-names-hidden'

function loadFilter(): AccountFilter {
  const defaults: AccountFilter = { provider: 'all', enabled: 'all', limit: 'all' }
  return shared().wbFilterMemory ? shared().wbFilterMemory!.load(FILTERS_KEY, defaults) : defaults
}

function loadNamesHidden(): boolean {
  try {
    return localStorage.getItem(NAMES_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

/* ─── store ─────────────────────────────────── */

let store: AccountsStore = {
  version: 0,
  filter: loadFilter(),
  selected: new Set<string>(),
  panels: new Map<string, ReadonlySet<PanelKind>>(),
  connections: new Map<string, number>(),
  clash: null,
  dialog: null,
  namesHidden: loadNamesHidden(),
  usageBusy: false,
  checkinBusy: false,
  usageInflight: new Set<string>(),
}

const listeners = new Set<() => void>()

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getStore(): AccountsStore {
  return store
}

/** 换一份快照并通知订阅者（React 侧 getSnapshot 的引用比较靠它） */
export function patch(partial: Partial<AccountsStore>): void {
  store = { ...store, ...partial, version: store.version + 1 }
  listeners.forEach(listener => listener())
}

/** 原地改过 Map / Set 之后调它（内容变了但对象引用没变） */
export function bump(): void {
  patch({})
}

/* ─── 从后端快照派生的读法（唯一入口）─────────── */

export function snapshot(): AccountsSnapshot | null | undefined {
  return shared().wbApp?.getState?.()?.accounts
}

export function allAccounts(): AccountRecord[] {
  const list = snapshot()?.accounts
  return Array.isArray(list) ? list : []
}

export function findAccount(id: string): AccountRecord | null {
  return allAccounts().find(account => account.id === id) || null
}

/** 当前可见账号（筛选三维度）与分段计数共用 accounts-domain 的同一份口径 */
export function visibleList(): AccountRecord[] {
  return visibleAccounts(allAccounts(), store.filter).slice().sort(byPriorityOrder)
}

export function providerSummaryList(): Array<{ id: string; label: string; count: number }> {
  return providerSummaries(snapshot())
}

export function segmentCounts(): Record<string, number> {
  return filterCounts(allAccounts(), store.filter, providerSummaryList())
}

/** 该账号在**全局队列**里的位置（序号与 ↑/↓ 的边界同源） */
export function seats(): Map<string, { position: number; total: number }> {
  return positionMap(allAccounts())
}

/* ─── 筛选 ─────────────────────────────────── */

function persistFilter(): void {
  shared().wbFilterMemory?.save(FILTERS_KEY, { ...store.filter })
}

export function setProviderFilter(value: string): void {
  patch({ filter: { ...store.filter, provider: value || 'all' } })
  persistFilter()
}

/** 切了档位：落盘 + 重绘。限流维度与启用状态联动 —— 状态筛成「禁用」时正常 / 有限流
 *  都不存在，于是把限流复位为「全部」（置灰由视图侧的 options.disabled 表达） */
export function setSegmentFilter(key: 'enabled' | 'limit', value: string): void {
  const filter: AccountFilter = { ...store.filter, [key]: value }
  if (filter.enabled === 'disabled' && filter.limit !== 'all') filter.limit = 'all'
  patch({ filter })
  persistFilter()
}

/** 提供商摘要里已不存在的 provider（账号被删光且注册表也移除了）复位成「全部」 */
export function normalizeFilter(): void {
  const { provider } = store.filter
  if (provider === 'all') return
  if (providerSummaryList().some(item => item.id === provider)) return
  patch({ filter: { ...store.filter, provider: 'all' } })
  persistFilter()
}

/* ─── 勾选（只作用于当前勾选，不随筛选变化自动增减）─── */

export function isPicked(id: string): boolean {
  return store.selected.has(id)
}

export function togglePick(id: string, picked: boolean): void {
  const next = new Set(store.selected)
  if (picked) next.add(id)
  else next.delete(id)
  patch({ selected: next })
}

export function setAllPicked(ids: string[], picked: boolean): void {
  const next = new Set(store.selected)
  for (const id of ids) {
    if (picked) next.add(id)
    else next.delete(id)
  }
  patch({ selected: next })
}

export function clearSelection(): void {
  patch({ selected: new Set<string>() })
}

/* ─── 行内明细面板的展开态 ─────────────────────
 * 这一份 Map 是「面板开着没」的**唯一判据来源**：单账号按钮、批量展开、渲染三处都只读它，
 * 谁都不自己另存一份布尔量。以后再加入口也必须走这里的函数，否则这条保证就断了。
 * 余额没有明细行（读数直接落在余额列上），所以只有 limits / checkin 两种 kind。 */

export function panelOpen(id: string, kind: PanelKind): boolean {
  return store.panels.get(id)?.has(kind) === true
}

export function setPanelOpen(id: string, kind: PanelKind, open: boolean): void {
  if (!id) return
  const panels = new Map(store.panels)
  const set = new Set(panels.get(id) || [])
  if (open) set.add(kind)
  else set.delete(kind)
  if (set.size) panels.set(id, set)
  else panels.delete(id)
  patch({ panels })
}

export function openPanelsFor(ids: string[], kind: PanelKind): void {
  const panels = new Map(store.panels)
  for (const id of ids) {
    const set = new Set(panels.get(id) || [])
    set.add(kind)
    panels.set(id, set)
  }
  patch({ panels })
}

/* ─── 账号名隐藏 ─────────────────────────────── */

export function toggleNamesHidden(): void {
  const next = !store.namesHidden
  try { localStorage.setItem(NAMES_HIDDEN_KEY, next ? '1' : '0') } catch { /* 存不了只影响下次启动 */ }
  patch({ namesHidden: next })
}

/**
 * 星号掩码：按原名长度生成、4~12 个封顶 —— 完全不保长会把账号列压成短短一截，与关闭时
 * 版式差得太多；封顶 12 则不让超长名字把星号串拉到撑破列宽。
 */
export function maskName(name: string): string {
  return '*'.repeat(Math.min(Math.max(name.length, 4), 12))
}
