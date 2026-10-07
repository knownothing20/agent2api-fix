/**
 * Agent2API · 设置页的**状态与流程层**（快照 store / 取数 / 写入 / 对外契约）。
 *
 * 从 settings-page.tsx 拆出来：视图层装完「五个分类 + 十来个面板 + 一个确认框」已超过项目
 * 约定的单文件体量，而这一层的边界很清楚 —— 没有 JSX。依赖单向（视图层 import 它，
 * 它只认识 settings-model.ts）。
 *
 * 它不是岛：文件名是 .ts，不会被 src/index.tsx 的 `islands/*.tsx` glob 加载；设置页的岛只有
 * settings-page.tsx 一个（页面级说明见它的文件头）。
 *
 * ── 状态放模块级快照 + useSyncExternalStore（照 update-panel / models-panel-state）──
 * 对外契约方法（load / renderXxx / showCategory）从 React 之外调用，且必须与界面共用同一份
 * 状态；组件内部的 useState 做不到这一点。所以状态是一份模块级快照，改动一律走 publish()
 * （换新对象再通知订阅者）。
 *
 * ── 每个「后端说了算」的块都是三态（LoadStatus）────────────────
 * loading / ready / unavailable —— 首屏徽章是「检测中…」而不是「不可用」，这两件事在旧实现里
 * 也是分开的（静态 HTML 写「检测中…」，读到坏数据才换「不可用」）。available 另有一层含义：
 * 数据存储面板的「数据库不可用」是**读到了但库打不开**，与「读不到」不是一回事。
 *
 * ── 两处与旧实现刻意不同的地方（都写在各函数旁边）────────────
 *   · 忙碌只按归属禁用（快照的 busy 是 'retention' / 'retry' 这样的记号），旧实现是各面板自己
 *     置 DOM disabled —— 界面等价，状态却只有一处；
 *   · 未提交的编辑留在各自控件里（视图层的草稿），流程只读写快照里的「生效值」，不再像旧实现
 *     那样从 DOM 读回正在编辑的数字。
 *
 * ── 数据来源（与旧实现逐条对应，一条都不能少）────────────────
 *   壳命令：getAppSettings / saveAppSettings（启动与托盘）、exportAccounts / importAccounts；
 *   HTTP 桥：retention / retry / timeouts / debug / sanitize / prompt / storage / captcha。
 *   全部经 window.workbuddyDesktop，本文件不自己拼 URL。
 */

import * as React from 'react'
import {
  CATEGORIES,
  NO_RETRY_CODES_KEY,
  PROMPT_MODES,
  QUEUE_FIELDS,
  RETENTION_FIELDS,
  CODEARTS_MAX_TOKENS_CAP_FIELD,
  WELFARE_ACCOUNT_GAP_FIELD,
  WELFARE_MIN_ATTEMPT_GAP_FIELD,
  WELFARE_MAX_ATTEMPTS_FIELD,
  RETRY_CODE_MAX,
  RETRY_CODE_MIN,
  RETRY_FIELDS,
  RETRY_MAX_CODES,
  SCHEDULING_MODES,
  SCHEDULING_WAIT_MAX,
  SCHEDULING_WAIT_MIN,
  SETTINGS_CAT_KEY,
  TIMEOUT_FIELDS,
  errorMessage,
  normalizeApp,
  normalizeNumbers,
  parseInteger,
  shared,
  toast,
  type AppSettings,
  type GatewayBlocks,
  type NumberField,
  type PromptPatch,
} from './settings-model'

/* ─── 快照类型 ─────────────────────────────── */

/** 三态：首屏「检测中…」、读到、读不到（三者对应的界面与旧实现逐一对齐） */
export type LoadStatus = 'loading' | 'ready' | 'unavailable'

/**
 * 忙碌归属：决定这一次操作期间哪些控件禁用（旧实现是各面板自己置 disabled，
 * 这里收成一处状态）。null = 空闲。
 */
export type BusyScope =
  | 'app'
  | 'retention'
  | 'retry'
  | 'codes'
  | 'timeouts'
  | 'queue'
  | 'debug'
  | 'hideReasoning'
  | 'forwardMode'
  | 'codeartsCap'
  | 'welfareSettings'
  | 'codeartsThinking'
  | 'sanitize'
  | 'prompt'
  | 'captcha'
  | 'scheduling'
  | 'export'
  | 'import'
  | null

/**
 * 启动与托盘。unavailable 时开关**仍可拨**（照旧实现：拨了直接发全量 patch，
 * 保存成功即回到 ready），只把徽章与状态行换成提示。
 */
export type AppState = {
  status: LoadStatus
  closeToTray: boolean
  autostart: boolean
}

/** 数值面板：values 为 null 时（loading / unavailable）各输入框保持禁用 */
export type NumericState = { status: LoadStatus; values: Record<string, number> | null }

export type DebugState = {
  status: LoadStatus
  on: boolean
  /** 已保存条数 / 上限；后端没给可用的数时为 null（文案里那一句整个不出现） */
  count: number | null
  limit: number | null
}

export type SanitizeState = { status: LoadStatus; on: boolean }

export type PromptState = {
  status: LoadStatus
  mode: string
  file: string
  /** **生效正文**（`passthrough` 下是空串）：界面直接编辑这一段 */
  text: string
  /** 后端给的来源：'file' | 'builtin' | 'inline' | ''（文案在视图层映射） */
  source: string
  lines: number
  fileError: string
  degradeActive: boolean
  degradeUntilText: string
  /** **按提供商**的覆盖（只含已单独配置的家，后端已按 id 排好序） */
  providers: ProviderPromptState[]
  /** **网关自带提示词**的逐家开关：只含被明确拨过的家（键缺失 = 默认装） */
  gateway: Record<string, boolean>
  /** **网关自带提示词的正文覆盖**：只含改过的家与段（缺的段 = 官方原文） */
  gatewayText: Record<string, GatewayBlocks>
  /** 可配置的家（下拉用）：注册表全量，含网关自带提示词的说明、规模与正文模板 */
  options: ProviderPromptOption[]
}

/** 单一提供商的提示词覆盖（字段与全局那份同构，同一套渲染逻辑） */
export type ProviderPromptState = {
  id: string
  mode: string
  file: string
  /** **生效正文**（同上；`passthrough` 下是空串） */
  text: string
  source: string
  lines: number
  fileError: string
  /** 这一家的**网关自带提示词**是否装上（缺省 true；只有带 `gatewayNote` 的家有意义） */
  gateway: boolean
  /** 是否**单独配过**（false = 这一行是按「有网关自带提示词」补出来的，各项跟随全局） */
  configured: boolean
}

/**
 * 可配置的家。
 *
 * `gatewayNote` 非空 = 这家有一段**网关自带**的提示词（ZCode 活动套餐通道的
 * 官方三段）。它同时决定这一家**默认就出现在列表里** —— 有开关可拨的家不该
 * 藏在一个「添加提供商…」后面。
 * `gatewayChars` 是那段装配的字符数（只读子行的「约 N 字符」；0 / 缺失不显示）。
 * `gatewayBlocks` 是那段装配的**正文模板**（三段，Environment 段带占位符）：
 * 编辑器拿它当初始值，也是「恢复官方原文」的目标 —— 资源坏了时是 null，
 * 此时界面不提供编辑入口（免得用户拿一份空文本把官方原文清掉）。
 */
export type ProviderPromptOption = {
  id: string
  label: string
  gatewayNote: string
  gatewayChars: number
  gatewayBlocks: GatewayBlocks | null
}

export type StorageState = {
  status: LoadStatus
  /** 库能不能打开（false = 「数据库不可用」徽章）；与 status 的「读不到」不同 */
  available: boolean
  file: string
  bytes: number
  /** 五个计数：null = 后端没给可用的数（展示「—」） */
  accounts: number | null
  logs: number | null
  requests: number | null
  dailyDays: number | null
  debug: number | null
}

/** 导入失败明细（只列前 3 条，more 表示还有更多） */
export type IoFailure = { failed: number; detail: string; more: boolean } | null

export type SettingsSnapshot = {
  /** 当前分类（左侧导航与右侧面板的显隐都由它派生） */
  category: string
  /** 每次 showCategory 递增：视图据此把内容栏滚回顶部（旧实现是命令式写 scrollTop） */
  scrollReset: number
  busy: BusyScope
  /** 「不下发思考」开关（与请求头 X-A2A-Hide-Reasoning 或的关系） */
  hideReasoning: { status: 'loading' | 'ready' | 'unavailable'; on: boolean }
  /** 转发模式：follow-* / always-* × stream / nonstream 四个取值 */
  forwardMode: { status: 'loading' | 'ready' | 'unavailable'; mode: string }
  /** 码道 max_tokens 硬顶（只对码道账号生效；0 = 不钳制） */
  codeartsCap: { status: 'loading' | 'ready' | 'unavailable'; value: number }
  /** 码道「禁用思考」开关（注入 thinking:{type:"disabled"}，默认关） */
  codeartsThinking: { status: 'loading' | 'ready' | 'unavailable'; on: boolean }
  /** 自动领福利的三个节流旋钮（账号之间 / 单账号写闸 ×2，2026-10-07） */
  welfareSettings: {
    status: 'loading' | 'ready' | 'unavailable'
    accountGap: number
    minAttemptGap: number
    maxAttempts: number
  }
  app: AppState
  unitsChinese: boolean
  retention: NumericState
  retry: NumericState
  /** 「指定错误码直接换号」名单；retry.status 为 unavailable 时是 null */
  retryCodes: number[] | null
  timeouts: NumericState
  queue: NumericState
  debug: DebugState
  sanitize: SanitizeState
  prompt: PromptState
  storage: StorageState
  captcha: { available: boolean; enabled: boolean }
  /**
   * 多账号调度（会话粘性固定生效）：`mode` = 粘性之后的第二级排序，
   * `waitSeconds` = 满员时等一个槽位最多等几秒（null = 还没读到后端值）
   */
  scheduling: { available: boolean; mode: string; waitSeconds: number | null }
  ioFailure: IoFailure
  /** 保留期改小的确认框正文（非空即开着）；确认 / 取消都收口到 resolveRetentionConfirm */
  retentionConfirm: { head: string } | null
  /** 面板登录整块：仅网页端渲染 */
  panelLogin: boolean
}

/** 是否网页端（桌面壳的面板跟着应用走，没有「登录面板」的概念） */
export function readPanelLogin(): boolean {
  return shared().workbuddyDesktop?.platform === 'web'
}

/** 首屏值：各面板都是「检测中…」，与静态骨架逐字一致 */
const INITIAL: SettingsSnapshot = {
  // 初值取第一个分类：restoreCategory / load 会把 localStorage 里的偏好盖上来
  category: CATEGORIES[0].id,
  scrollReset: 0,
  busy: null,
  app: { status: 'loading', closeToTray: false, autostart: false },
  unitsChinese: true,
  retention: { status: 'loading', values: null },
  retry: { status: 'loading', values: null },
  retryCodes: null,
  timeouts: { status: 'loading', values: null },
  queue: { status: 'loading', values: null },
  debug: { status: 'loading', on: false, count: null, limit: null },
  hideReasoning: { status: 'loading', on: false },
  forwardMode: { status: 'loading', mode: 'follow-nonstream' },
  codeartsCap: { status: 'loading', value: 65536 },
  welfareSettings: { status: 'loading', accountGap: 10, minAttemptGap: 10, maxAttempts: 6 },
  codeartsThinking: { status: 'loading', on: false },
  sanitize: { status: 'loading', on: false },
  prompt: {
    status: 'loading',
    mode: 'passthrough',
    file: '',
    text: '',
    source: '',
    lines: 0,
    fileError: '',
    degradeActive: false,
    degradeUntilText: '',
    providers: [],
    gateway: {},
    gatewayText: {},
    options: [],
  },
  storage: {
    status: 'loading',
    available: true,
    file: '',
    bytes: 0,
    accounts: null,
    logs: null,
    requests: null,
    dailyDays: null,
    debug: null,
  },
  captcha: { available: true, enabled: false },
  // 默认与后端一致（creditFirst = 积分优先、等待 30 秒）：后端认不出这两个键时也是它们
  scheduling: { available: true, mode: 'creditFirst', waitSeconds: 30 },
  ioFailure: null,
  retentionConfirm: null,
  panelLogin: false,
}

/* ─── 快照 store ───────────────────────────── */

let snapshot: SettingsSnapshot = { ...INITIAL, panelLogin: readPanelLogin() }

const subscribers = new Set<() => void>()

export function subscribe(listener: () => void): () => void {
  subscribers.add(listener)
  return () => { subscribers.delete(listener) }
}

export function getSnapshot(): SettingsSnapshot {
  return snapshot
}

/** 视图层订阅入口（useSyncExternalStore 靠引用比较判变化，publish 必须换新对象） */
export function useSettings(): SettingsSnapshot {
  return React.useSyncExternalStore(subscribe, getSnapshot)
}

function publish(patch: Partial<SettingsSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of subscribers) listener()
}

/**
 * 强制重绘一次（内容不变）。
 *
 * 用途只有一个：受控开关在「忙碌中被拨动」时要把界面拉回快照的值 —— 旧实现是显式把
 * DOM 的 checked 翻回去，React 这边只要让订阅者重跑一次渲染即可。
 */
function repaint(): void {
  publish({})
}

/**
 * 「一次只干一件事」的互斥锁（旧实现的 panelBusy）。
 *
 * 刻意放模块级而不是快照里：流程里要**同步**读到它（同一刻的第二下、disabled 触发的
 * blur 补发 change 都靠它早退）。快照里的 busy 只服务界面禁用，两者不混。
 */
let busyScope: BusyScope = null

function beginBusy(scope: Exclude<BusyScope, null>): void {
  busyScope = scope
  publish({ busy: scope })
}

function endBusy(): void {
  busyScope = null
  publish({ busy: null })
}

/* ─── 界面偏好：当前分类 / 计量单位 ─────────── */

/**
 * 切换分类。分类表由本页渲染（不再由 HTML 声明），所以校验改成查表；传进来的值可能来自
 * localStorage、也可能来自被改过的调用方，不存在就回落到第一个，保证任何时候都有一类展开。
 * 滚回顶部交给视图层（快照里的 scrollReset）。
 *
 * 刻意**不写** localStorage：update-panel 的「去更新」深链会调它切到「更新」，
 * 那不该改用户手点的默认分类（写偏好的是 selectCategory）。
 */
export function showCategory(category?: string | null): void {
  const target = CATEGORIES.some(item => item.id === category)
    ? String(category)
    : CATEGORIES[0].id
  publish({ category: target, scrollReset: snapshot.scrollReset + 1 })
}

/** 导航项点击：切换并记住偏好 */
export function selectCategory(category: string): void {
  showCategory(category)
  try { localStorage.setItem(SETTINGS_CAT_KEY, category) } catch { /* 存储不可用只影响下次启动 */ }
}

/** 按 localStorage 恢复上次所在的分类（非法值由 showCategory 兜底） */
export function restoreCategory(): void {
  let saved: string | null = null
  try { saved = localStorage.getItem(SETTINGS_CAT_KEY) } catch { saved = null }
  showCategory(saved)
}

/**
 * 计量单位是纯前端偏好（值与该存哪、默认是什么由 units.js 说了算），
 * 这里只把开关画成当前状态、并在拨动时写回去。拨一下立即生效：报表页订阅了
 * `wb-units-changed`，收到后用手里那份数据原地重绘。
 */
export function renderUnits(): void {
  publish({ unitsChinese: shared().wbUnits?.isChinese?.() !== false })
}

export function applyUnits(on: boolean): void {
  shared().wbUnits?.setChinese?.(on)
  renderUnits()
  toast(on ? '✅ 已改用中文单位（亿 / 万）' : '✅ 已改用英文单位（M / k）')
}

/* ─── 启动与托盘 ───────────────────────────── */

/**
 * 铺启动设置。传 undefined 不做事（React 侧本来就是派生渲染，没有「按旧值重绘」这回事）；
 * 传 null / 非对象按「主进程未返回」处理，但**保留当前开关值** —— 旧实现那时也没动 DOM 的
 * checked，刷新失败不该把用户刚拨的开关吞掉。
 */
export function renderSettings(data?: unknown): void {
  if (data === undefined) return
  if (!data || typeof data !== 'object') {
    publish({ app: { ...snapshot.app, status: 'unavailable' } })
    return
  }
  const record = data as Record<string, unknown>
  // 主进程返回的字段一律按「严格 true」判定，缺字段时按关闭处理（与后端默认值一致）
  publish({
    app: { status: 'ready', closeToTray: record.closeToTray === true, autostart: record.autostart === true },
  })
}

async function loadSettings(): Promise<void> {
  try {
    renderSettings(await shared().workbuddyDesktop?.getAppSettings())
  } catch (error) {
    console.warn('读取应用设置失败:', errorMessage(error))
    renderSettings(null)
  }
}

/**
 * 拨动启动 / 托盘开关。patch 是**全量覆盖**（契约要求），另一项取快照里的当前值
 * —— 旧实现读的是 DOM 里那个 checkbox 的 checked，等价。
 * 忙碌中早退时什么都不写：受控开关的 checked 来自快照，界面自动「还原这一下拨动」。
 */
export async function saveToggle(kind: 'tray' | 'autostart', next: boolean): Promise<void> {
  if (busyScope) { repaint(); return }
  const previous = snapshot.app
  const patch: AppSettings = {
    closeToTray: kind === 'tray' ? next : previous.closeToTray,
    autostart: kind === 'autostart' ? next : previous.autostart,
  }
  beginBusy('app')
  publish({ app: { ...previous, ...patch } })
  const label = kind === 'autostart' ? '开机自动启动' : '关闭窗口时最小化到托盘'
  try {
    const api = shared().workbuddyDesktop
    if (!api) throw new Error('主进程桥不可用')
    const saved = await api.saveAppSettings(patch)
    // 以主进程返回的设置为准渲染，避免界面与真实状态不一致
    publish({ app: { status: 'ready', ...normalizeApp(saved, patch) } })
    toast(`✅ 已更新「${label}」`)
  } catch (error) {
    // 回滚到拨动前的状态（旧实现：已知状态按状态回滚，未知状态只把刚切的这项切回去）
    publish({ app: previous })
    toast(`保存失败：${errorMessage(error)}`, 'err')
  } finally {
    endBusy()
  }
}

/* ─── 账号导入 / 导出 ──────────────────────── */

/**
 * 导出。忙碌守卫与旧实现的 guard() 同形：点下去的那个按钮禁用并换文案（视图按
 * busy === 'export' 派生），另一个按钮保持可点但会被守卫挡下（旧实现也是这样）。
 */
export async function exportAccounts(): Promise<void> {
  if (busyScope) return
  publish({ ioFailure: null })
  beginBusy('export')
  try {
    const result = await shared().workbuddyDesktop?.exportAccounts()
    if (result?.canceled) { toast('已取消导出'); return }
    const count = Number(result?.count) || 0
    const providers = Number(result?.customProviders) || 0
    if (!count && !providers) { toast('没有可导出的账号', 'err'); return }
    // v2 导出文件附带自定义提供商定义：账号为 0 但有定义时同样值得导
    const providerNote = providers ? `、${providers} 个自定义提供商` : ''
    toast(`✅ 已导出 ${count} 个账号${providerNote}${result?.file ? ` 到 ${result.file}` : ''}`)
  } catch (error) {
    toast(`操作失败：${errorMessage(error)}`, 'err')
  } finally {
    endBusy()
  }
}

/** 导入：合并策略在后端，这里只负责把结果摊成人话（失败明细收进快照，由视图渲染） */
export async function importAccounts(): Promise<void> {
  if (busyScope) return
  publish({ ioFailure: null })
  beginBusy('import')
  try {
    const result = await shared().workbuddyDesktop?.importAccounts()
    if (result?.canceled) { toast('已取消导入'); return }

    const added = Number(result?.added) || 0
    const updated = Number(result?.updated) || 0
    const skipped = Number(result?.skipped) || 0
    const failed = Number(result?.failed) || 0
    const errors = Array.isArray(result?.errors) ? result.errors : []
    const custom = result?.customProviders ?? {}
    const customAdded = Number(custom.added) || 0
    const customUpdated = Number(custom.updated) || 0

    const extras: string[] = []
    if (skipped) extras.push(`跳过 ${skipped} 个`)
    if (failed) extras.push(`失败 ${failed} 个`)
    const suffix = extras.length ? `，${extras.join('、')}` : ''
    const providerNote = (customAdded || customUpdated)
      ? `，自定义提供商新增 ${customAdded} 个、更新 ${customUpdated} 个`
      : ''
    const summary = `新增 ${added} 个、更新 ${updated} 个${suffix}${providerNote}`

    if (failed) {
      toast(`导入完成：${summary}`, 'err')
      // 失败明细只列前 3 条，与账号页批量操作的展示密度保持一致；
      // 定义警告（customProvider 标记）没有账号语义，展示时注明归属
      const detail = errors.slice(0, 3)
        .map(item => {
          const label = item?.customProvider
            ? `自定义提供商 ${item?.id || '(无 id)'}`
            : (item?.id ?? '未知账号')
          return `${label}（${item?.message ?? '未知原因'}）`
        })
        .join('；')
      publish({ ioFailure: { failed, detail, more: errors.length > 3 } })
    } else {
      toast(`✅ 导入完成：${summary}`)
    }

    // 账号被改动（新增/更新）后让主界面立刻反映：账号列表、导航计数等；
    // 自定义提供商定义有变化时同样要刷（分组名、模型清单都会变）
    if (added || updated || customAdded || customUpdated) await shared().wbApp?.refresh?.()
  } catch (error) {
    toast(`操作失败：${errorMessage(error)}`, 'err')
  } finally {
    endBusy()
  }
}

/* ─── 数据保留（三项保留天数） ─────────────── */

export function renderRetention(data?: unknown): void {
  if (data === undefined) return
  const values = normalizeNumbers(RETENTION_FIELDS, data, snapshot.retention.values)
  publish({ retention: { status: values === null ? 'unavailable' : 'ready', values } })
}

async function loadRetention(): Promise<void> {
  try {
    renderRetention(await shared().workbuddyDesktop?.getRetention())
  } catch (error) {
    console.warn('读取数据保留设置失败:', errorMessage(error))
    renderRetention(null)
  }
}

/** 确认弹窗的 Promise resolver；非空即表示弹窗开着 */
let retentionConfirmResolver: ((accepted: boolean) => void) | null = null

/** 关窗并把结果交给等待者（重复调用无副作用：resolver 取走即置空） */
export function resolveRetentionConfirm(accepted: boolean): void {
  const resolve = retentionConfirmResolver
  retentionConfirmResolver = null
  publish({ retentionConfirm: null })
  resolve?.(accepted)
}

/** 弹确认框，返回 Promise<boolean>：确认继续为 true，取消 / 关窗 / Esc 为 false */
function askRetentionShrink(head: string): Promise<boolean> {
  return new Promise(resolve => {
    // 理论上同时只有一个问题（saveRetentionField 已挡掉重入），这里仍兜一层：
    // 万一有第二个问题挤进来，先把旧的按「取消」收尾，而不是让它的 Promise 永远挂着
    if (retentionConfirmResolver) resolveRetentionConfirm(false)
    retentionConfirmResolver = resolve
    publish({ retentionConfirm: { head } })
  })
}

/** 改小保留期会立即删数据，文案必须点名「删的是哪一档」 */
function shrinkPromptHead(field: NumberField, previous: number | null, days: number): string {
  return previous === null
    ? `没能读到「${field.label}」的当前值，改为 ${days} 天可能会删除超出的历史数据。`
    : `「${field.label}」将从 ${previous} 天改为 ${days} 天。`
}

/**
 * 单个输入框的提交流程：校验 → （改小时）确认 → 提交。任一步失败都不写快照，
 * 视图层把草稿收掉，显示回到生效值（旧实现是显式 revert）。
 */
export async function saveRetentionField(field: NumberField, raw: string): Promise<void> {
  if (busyScope) return
  // 确认框开着时不再受理新的编辑：一次只问一个问题，否则第二个问题会把第一个顶掉
  // （resolver 只能存一个），那个输入框就会在没人点过「取消」的情况下被回滚。
  // 遮罩已经挡住了页面，走到这里只剩键盘 Tab 之类的少数路径，挡一下成本极低。
  if (snapshot.retentionConfirm) return

  const parsed = parseInteger(raw, field.min, field.max, '天数')
  if (!parsed.ok) { toast(parsed.message, 'err'); return }

  const known = snapshot.retention.values?.[field.key]
  const previous = typeof known === 'number' && Number.isInteger(known) ? known : null
  // 值与后端一致就不发请求：数字框里换个写法（如 007）也会触发 change
  if (previous !== null && parsed.value === previous) return

  // 读不到旧值时无从判断是否改小 —— 只有改小才会删数据，所以这里宁可多问一次：
  // 白弹一次确认的代价，远小于静默删掉用户的历史数据
  const shrinking = previous === null || parsed.value < previous
  if (shrinking && !await askRetentionShrink(shrinkPromptHead(field, previous, parsed.value))) return

  await commitRetention(field, parsed.value, shrinking)
}

/**
 * 提交一项保留期：只传变化的那一个字段 —— 后端支持部分字段（未出现的项保持原值），
 * 整份回传会把另外两项也卷进「是否改小」的确认范围，白白多弹一次窗。
 * shrinking 表示这次是改小（后端会顺手清理），决定提示语要不要提「已清理」。
 */
async function commitRetention(field: NumberField, days: number, shrinking: boolean): Promise<void> {
  if (busyScope) return
  beginBusy('retention')
  // 乐观写入待保存的值，再禁用输入框（视图按 busy === 'retention' 禁用）。理由：Chromium 里
  // 「让正在聚焦的输入框 disabled」会触发一次 blur，而 blur 可能补发 change —— 那个重入的
  // 提交会走忙碌分支早退；不先记新值，用户就会看到「刚改的数字闪回旧值、过一下又变回来」。
  // 真失败了下面的 catch 会重读后端覆盖，所以这个乐观值不会被留在界面上。
  const optimistic = snapshot.retention.values
  if (optimistic) publish({ retention: { status: 'ready', values: { ...optimistic, [field.key]: days } } })
  try {
    const saved = await shared().workbuddyDesktop?.saveRetention({ [field.key]: days })
    // PUT 契约上返回生效后的**三项**值，正常情况下用响应刷新即可，不必再跑一趟 GET
    renderRetention(saved)
    const values = snapshot.retention.values
    if (RETENTION_FIELDS.every(item => Number.isInteger(values?.[item.key]))) {
      const applied = values?.[field.key] ?? days
      toast(shrinking ? `✅ 已保留 ${applied} 天，超出部分已清理` : `✅ 已保留 ${applied} 天`)
      return
    }
    // 响应里三项没齐（换壳后接口形状变了之类）：退回一次 GET 补齐，
    // 宁可多跑一趟，也不能停在「界面说改了、其实没读到真值」的状态
    await loadRetention()
    // 这里提示用户填的值：GET 也没读到真值时，报后端返回的值反而更让人困惑
    toast(shrinking ? `✅ 已保留 ${days} 天，超出部分已清理` : `✅ 已保留 ${days} 天`)
  } catch (error) {
    // 400 的 message（点名哪个字段、超出多少）比自造一句更指向具体问题
    toast(`保存失败：${errorMessage(error)}`, 'err')
    await loadRetention() // 回滚到后端的真实值
  } finally {
    endBusy()
  }
}

/* ─── 数字型设置面板的通用壳（请求重试 / 请求超时共用）── */

/**
 * 一个「后端存一份全量值 + 页面上若干数字输入框」的面板壳：加载回填、逐框保存、
 * 失败回滚、后端不可用时整块禁用。两处交互**逐字相同**（都是「多字段 + 允许部分更新
 * + 返回全量值」那类端点），各写一份必然漂。数据保留不并入 —— 它有二次确认与清理数据的
 * 副作用，语义不同。
 *
 * `syncExtras(data | null)`：本壳只管数字；同一面板里别的控件（重试面板的「指定错误码
 * 直接换号」名单）由各自的代码实现，在数据到达 / 不可用时被回调一次。
 */
type NumericPanel = {
  scope: 'retry' | 'timeouts' | 'queue'
  fields: NumberField[]
  consoleLabel: string
  /** 取数 / 写回：桥不在时给 undefined（各调用点按「读不到」处理） */
  get: () => Promise<unknown> | undefined
  save: (patch: Record<string, number>) => Promise<unknown> | undefined
  /** 读 / 写快照里的生效值（null = 不可用） */
  read: () => NumericState
  write: (state: NumericState) => void
  syncExtras?: (data: unknown) => void
}

/** 按响应重铺面板：只采纳范围内的整数，缺字段沿用上一轮；一项都没有则整块不可用 */
function renderNumericPanel(panel: NumericPanel, data: unknown): void {
  if (data === undefined) return
  const values = normalizeNumbers(panel.fields, data, panel.read().values)
  panel.write({ status: values === null ? 'unavailable' : 'ready', values })
  panel.syncExtras?.(values === null ? null : data)
}

async function loadNumericPanel(panel: NumericPanel): Promise<void> {
  try {
    renderNumericPanel(panel, await panel.get())
  } catch (error) {
    console.warn(`${panel.consoleLabel}失败:`, errorMessage(error))
    renderNumericPanel(panel, null)
  }
}

/** 单个输入框的提交流程：校验 → 提交，失败回滚（与保留期同款，少一道确认） */
async function saveNumericField(panel: NumericPanel, field: NumberField, raw: string): Promise<void> {
  if (busyScope) return

  const parsed = parseInteger(raw, field.min, field.max, field.label)
  if (!parsed.ok) { toast(parsed.message, 'err'); return }

  const known = panel.read().values?.[field.key]
  // 值与后端一致就不发请求：数字框里换个写法（如 05）也会触发 change
  if (Number.isInteger(known) && parsed.value === known) return

  beginBusy(panel.scope)
  // 乐观写入待保存的值（理由同 commitRetention）
  const current = panel.read().values
  if (current) panel.write({ status: 'ready', values: { ...current, [field.key]: parsed.value } })
  try {
    const saved = await panel.save({ [field.key]: parsed.value })
    // PUT 契约返回生效后的全量值，正常情况下用响应刷新即可，不必再跑一趟 GET
    renderNumericPanel(panel, saved)
    const applied = panel.read().values?.[field.key]
    toast(`✅ 已保存：${field.label} ${Number.isInteger(applied) ? applied : parsed.value}`)
  } catch (error) {
    // 400 的 message（点名哪个字段、超出多少）比自造一句更指向具体问题
    toast(`保存失败：${errorMessage(error)}`, 'err')
    await loadNumericPanel(panel) // 回滚到后端的真实值
  } finally {
    endBusy()
  }
}

/* ─── 排队等待 ─────────────────────────────── */

const queuePanel: NumericPanel = {
  scope: 'queue',
  fields: QUEUE_FIELDS,
  consoleLabel: '读取排队等待设置',
  get: () => shared().workbuddyDesktop?.getQueue(),
  save: patch => shared().workbuddyDesktop?.saveQueue(patch),
  read: () => snapshot.queue,
  write: state => publish({ queue: state }),
}

export function renderQueue(data?: unknown): void {
  renderNumericPanel(queuePanel, data)
}

export async function loadQueue(): Promise<void> {
  await loadNumericPanel(queuePanel)
}

export async function saveQueueField(field: NumberField, raw: string): Promise<void> {
  await saveNumericField(queuePanel, field, raw)
}

/* ─── 请求重试 ─────────────────────────────── */

const retryPanel: NumericPanel = {
  scope: 'retry',
  fields: RETRY_FIELDS,
  consoleLabel: '读取请求重试设置',
  get: () => shared().workbuddyDesktop?.getRetry(),
  save: patch => shared().workbuddyDesktop?.saveRetry(patch),
  read: () => snapshot.retry,
  write: state => publish({ retry: state }),
  syncExtras: data => {
    // 「指定错误码直接换号」的名单：只收 100–599 的整数项（后端已排序去重，这里不再排序
    // —— 顺序就是后端给的）。键缺失（旧后端）时沿用上一轮的值，不误判成「清空」；
    // data 为 null（整块不可用）时清掉并锁住输入框。
    if (data === null) { publish({ retryCodes: null }); return }
    const raw = (data as Record<string, unknown>)[NO_RETRY_CODES_KEY]
    if (!Array.isArray(raw)) return
    const list = raw as unknown[]
    publish({
      retryCodes: list.filter((code): code is number =>
        typeof code === 'number' && Number.isInteger(code)
        && code >= RETRY_CODE_MIN && code <= RETRY_CODE_MAX),
    })
  },
}

export function renderRetry(data?: unknown): void {
  renderNumericPanel(retryPanel, data)
}

export async function loadRetry(): Promise<void> {
  await loadNumericPanel(retryPanel)
}

export async function saveRetryField(field: NumberField, raw: string): Promise<void> {
  await saveNumericField(retryPanel, field, raw)
}

/** 增删后的统一提交：乐观更新本地值 → PUT → 用响应里的生效值重画 */
async function saveRetryCodes(codes: number[]): Promise<void> {
  if (busyScope) return
  publish({ retryCodes: codes })
  beginBusy('codes')
  try {
    const saved = await shared().workbuddyDesktop?.saveRetry({ [NO_RETRY_CODES_KEY]: codes })
    // PUT 契约返回生效后的全量值（含三个数字项），交给面板统一回填，
    // 顺带把徽章重画成后端确认的形态（排序去重后的结果）
    renderNumericPanel(retryPanel, saved)
    toast('✅ 已保存：指定错误码直接换号')
  } catch (error) {
    toast(`保存失败：${errorMessage(error)}`, 'err')
    await loadNumericPanel(retryPanel) // 回滚到后端的真实值
  } finally {
    endBusy()
  }
}

/** 校验并添加一枚：整数、100–599、去重、限量（口径与后端 400 文案同源） */
export async function addRetryCode(raw: string): Promise<void> {
  const codes = snapshot.retryCodes
  if (codes === null) return
  const text = String(raw ?? '').trim()
  if (!text) return
  if (!/^\d+$/.test(text) || Number(text) < RETRY_CODE_MIN || Number(text) > RETRY_CODE_MAX) {
    toast(`状态码必须是 ${RETRY_CODE_MIN}–${RETRY_CODE_MAX} 的整数（收到: ${text}）`, 'err')
    return
  }
  const code = Number(text)
  if (codes.includes(code)) { toast(`状态码 ${code} 已在名单里`); return }
  if (codes.length >= RETRY_MAX_CODES) {
    toast(`名单最多 ${RETRY_MAX_CODES} 个状态码`, 'err')
    return
  }
  await saveRetryCodes([...codes, code])
}

/** 删除一枚（点徽章上的 ✕） */
export async function removeRetryCode(code: number): Promise<void> {
  const codes = snapshot.retryCodes
  if (!codes || !codes.includes(code)) return
  await saveRetryCodes(codes.filter(item => item !== code))
}

/** 输入框为空时退格删最后一枚（与 GitHub Topics 一致） */
export async function dropLastRetryCode(): Promise<void> {
  const codes = snapshot.retryCodes
  if (!codes?.length) return
  await saveRetryCodes(codes.slice(0, -1))
}

/* ─── 请求超时 ─────────────────────────────── */

const timeoutsPanel: NumericPanel = {
  scope: 'timeouts',
  fields: TIMEOUT_FIELDS,
  consoleLabel: '读取请求超时设置',
  get: () => shared().workbuddyDesktop?.getTimeouts(),
  save: patch => shared().workbuddyDesktop?.saveTimeouts(patch),
  read: () => snapshot.timeouts,
  write: state => publish({ timeouts: state }),
}

export async function loadTimeouts(): Promise<void> {
  await loadNumericPanel(timeoutsPanel)
}

export async function saveTimeoutField(field: NumberField, raw: string): Promise<void> {
  await saveNumericField(timeoutsPanel, field, raw)
}

/* ─── 调试模式 / 指纹脱敏（两个同构的全局布尔开关）── */

export function renderDebug(data?: unknown): void {
  if (data === undefined) return
  if (!data || typeof data !== 'object') {
    publish({ debug: { status: 'unavailable', on: false, count: null, limit: null } })
    return
  }
  const record = data as Record<string, unknown>
  const count = Number(record.count)
  const limit = Number(record.limit)
  publish({
    debug: {
      status: 'ready',
      on: record.debugMode === true,
      count: Number.isInteger(count) ? count : null,
      limit: Number.isInteger(limit) ? limit : null,
    },
  })
}

export function renderHideReasoning(data?: unknown): void {
  if (data === undefined) return
  if (!data || typeof data !== 'object') {
    publish({ hideReasoning: { status: 'unavailable', on: false } })
    return
  }
  publish({
    hideReasoning: {
      status: 'ready',
      on: (data as { hideReasoning?: unknown }).hideReasoning === true,
    },
  })
}

async function loadDebug(): Promise<void> {
  try {
    renderDebug(await shared().workbuddyDesktop?.getDebug())
  } catch (error) {
    console.warn('读取调试模式设置失败:', errorMessage(error))
    renderDebug(null)
  }
}

export function renderForwardMode(data?: unknown): void {
  if (data === undefined) return
  if (!data || typeof data !== 'object') {
    publish({ forwardMode: { status: 'unavailable', mode: 'follow-nonstream' } })
    return
  }
  const mode = String((data as { forwardMode?: unknown }).forwardMode || '')
  publish({
    forwardMode: {
      status: 'ready',
      mode: /^(follow|always)-(stream|nonstream)$/.test(mode) ? mode : 'follow-nonstream',
    },
  })
}

/** 桥方法缺失时的兜底：桥本来就是 `call(method, path)` 的薄壳（见 bridge.rs），
 *  所以直接打同一个端点完全等价。存在的意义：**桌面壳没跟着更新**时（比如只发布了
 *  服务端镜像），这两个开关仍然能用，不必为了两个开关重装一次 app。
 *  读用 GET、写用 PUT，返回值都取响应体的 `data`（与桥的返回形状一致）。 */
async function bridgeOrApi<T>(name: string, path: string, body?: unknown): Promise<T> {
  const bridge = shared().workbuddyDesktop as unknown as Record<string, unknown> | undefined
  const method = bridge?.[name]
  if (typeof method === 'function') {
    return (method as (arg?: unknown) => Promise<T>).call(bridge, body)
  }
  const response = await fetch(path, body === undefined ? {} : {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as { data?: T }
  return (payload.data ?? payload) as T
}

async function loadForwardMode(): Promise<void> {
  try {
    renderForwardMode(await bridgeOrApi('getForwardMode', '/api/forwardMode'))
  } catch (error) {
    console.warn('读取转发模式设置失败:', errorMessage(error))
    renderForwardMode(null)
  }
}

/** 转发模式：四个取值由设置页那两个控件（模式 + 按客户端要求）组合而来。 */
export async function saveForwardMode(next: string): Promise<void> {
  if (busyScope) { repaint(); return }
  beginBusy('forwardMode')
  publish({ forwardMode: { ...snapshot.forwardMode, mode: next } })
  try {
    const saved = await bridgeOrApi('saveForwardMode', '/api/forwardMode', { forwardMode: next })
    renderForwardMode(saved)
    toast(`✅ 转发模式已改为 ${next}`)
  } catch (error) {
    toast(`保存失败: ${errorMessage(error)}`, 'err')
    await loadForwardMode()
  } finally {
    endBusy()
  }
}

export function renderCodeartsCap(data?: unknown): void {
  if (data === undefined) return
  if (!data || typeof data !== 'object') {
    publish({ codeartsCap: { status: 'unavailable', value: 65536 } })
    return
  }
  const raw = (data as { codeartsMaxTokensCap?: unknown }).codeartsMaxTokensCap
  publish({
    codeartsCap: {
      status: 'ready',
      value: typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 65536,
    },
  })
}

async function loadCodeartsCap(): Promise<void> {
  try {
    renderCodeartsCap(await bridgeOrApi('getCodeartsMaxTokensCap', '/api/codeartsMaxTokensCap'))
  } catch (error) {
    console.warn('读取码道 max_tokens 硬顶失败:', errorMessage(error))
    renderCodeartsCap(null)
  }
}

/** 码道 max_tokens 硬顶（只对码道账号生效；0 = 不钳制）。 */
export async function saveCodeartsCap(raw: string): Promise<void> {
  const parsed = parseInteger(
    raw,
    CODEARTS_MAX_TOKENS_CAP_FIELD.min,
    CODEARTS_MAX_TOKENS_CAP_FIELD.max,
    CODEARTS_MAX_TOKENS_CAP_FIELD.label,
  )
  if (!parsed.ok) {
    toast(parsed.message, 'err')
    return
  }
  if (busyScope) { repaint(); return }
  beginBusy('codeartsCap')
  publish({ codeartsCap: { ...snapshot.codeartsCap, value: parsed.value } })
  try {
    const saved = await bridgeOrApi('saveCodeartsMaxTokensCap', '/api/codeartsMaxTokensCap', {
      codeartsMaxTokensCap: parsed.value,
    })
    renderCodeartsCap(saved)
    toast(parsed.value === 0 ? '✅ 已保存：码道 max_tokens 不再钳制' : `✅ 已保存：码道 max_tokens 硬顶 ${parsed.value}`)
  } catch (error) {
    toast(`保存失败: ${errorMessage(error)}`, 'err')
    await loadCodeartsCap()
  } finally {
    endBusy()
  }
}

export function renderCodeartsThinking(data?: unknown): void {
  if (data === undefined) return
  if (!data || typeof data !== 'object') {
    publish({ codeartsThinking: { status: 'unavailable', on: false } })
    return
  }
  const raw = (data as { codeartsDisableThinking?: unknown }).codeartsDisableThinking
  publish({ codeartsThinking: { status: 'ready', on: raw === true } })
}

async function loadCodeartsThinking(): Promise<void> {
  try {
    renderCodeartsThinking(await bridgeOrApi('getCodeartsThinking', '/api/codeartsThinking'))
  } catch (error) {
    console.warn('读取码道「禁用思考」失败:', errorMessage(error))
    renderCodeartsThinking(null)
  }
}

/** 码道「禁用思考」：开了就注入 thinking:{type:"disabled"}（思考归 0、正文直出）。 */
export async function saveCodeartsThinking(enabled: boolean): Promise<void> {
  if (busyScope) { repaint(); return }
  beginBusy('codeartsThinking')
  publish({ codeartsThinking: { ...snapshot.codeartsThinking, on: enabled } })
  try {
    const saved = await bridgeOrApi('saveCodeartsThinking', '/api/codeartsThinking', {
      codeartsDisableThinking: enabled,
    })
    renderCodeartsThinking(saved)
    toast(enabled ? '✅ 已开启：码道请求将禁用思考（正文直出、不再烧思考 token）' : '✅ 已关闭：恢复为给思考预留额度')
  } catch (error) {
    toast(`保存失败: ${errorMessage(error)}`, 'err')
    await loadCodeartsThinking()
  } finally {
    endBusy()
  }
}

export function renderWelfareSettings(data?: unknown): void {
  if (data === undefined) return
  if (!data || typeof data !== 'object') {
    publish({ welfareSettings: { status: 'unavailable', accountGap: 10, minAttemptGap: 10, maxAttempts: 6 } })
    return
  }
  const raw = data as {
    welfareAccountGapMinutes?: unknown
    welfareMinAttemptGapMinutes?: unknown
    welfareMaxAttemptsPerDay?: unknown
  }
  const pick = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  publish({
    welfareSettings: {
      status: 'ready',
      accountGap: pick(raw.welfareAccountGapMinutes, 10),
      minAttemptGap: pick(raw.welfareMinAttemptGapMinutes, 10),
      maxAttempts: pick(raw.welfareMaxAttemptsPerDay, 6),
    },
  })
}

async function loadWelfareSettings(): Promise<void> {
  try {
    renderWelfareSettings(await bridgeOrApi('getWelfareSettings', '/api/welfareSettings'))
  } catch (error) {
    console.warn('读取福利节流设置失败:', errorMessage(error))
    renderWelfareSettings(null)
  }
}

/** 福利节流三个旋钮：改其中一个，三个值一起 PUT（后端要求给全，不做部分更新）。 */
export async function saveWelfareSettings(
  kind: 'accountGap' | 'minAttemptGap' | 'maxAttempts',
  raw: string,
): Promise<void> {
  const field =
    kind === 'accountGap'
      ? WELFARE_ACCOUNT_GAP_FIELD
      : kind === 'minAttemptGap'
        ? WELFARE_MIN_ATTEMPT_GAP_FIELD
        : WELFARE_MAX_ATTEMPTS_FIELD
  const parsed = parseInteger(raw, field.min, field.max, field.label)
  if (!parsed.ok) {
    toast(parsed.message, 'err')
    return
  }
  if (busyScope) { repaint(); return }
  const current = snapshot.welfareSettings
  const next = {
    accountGap: kind === 'accountGap' ? parsed.value : current.accountGap,
    minAttemptGap: kind === 'minAttemptGap' ? parsed.value : current.minAttemptGap,
    maxAttempts: kind === 'maxAttempts' ? parsed.value : current.maxAttempts,
  }
  beginBusy('welfareSettings')
  publish({ welfareSettings: { ...current, ...next } })
  try {
    const saved = await bridgeOrApi('saveWelfareSettings', '/api/welfareSettings', {
      welfareAccountGapMinutes: next.accountGap,
      welfareMinAttemptGapMinutes: next.minAttemptGap,
      welfareMaxAttemptsPerDay: next.maxAttempts,
    })
    renderWelfareSettings(saved)
    toast(`✅ 已保存：账号之间 ${next.accountGap} 分钟、单账号写闸 ${next.minAttemptGap} 分钟 / 每天 ${next.maxAttempts} 次`)
  } catch (error) {
    toast(`保存失败: ${errorMessage(error)}`, 'err')
    await loadWelfareSettings()
  } finally {
    endBusy()
  }
}

async function loadHideReasoning(): Promise<void> {
  try {
    renderHideReasoning(await bridgeOrApi('getHideReasoning', '/api/hideReasoning'))
  } catch (error) {
    console.warn('读取「不下发思考」设置失败:', errorMessage(error))
    renderHideReasoning(null)
  }
}

/** 「不下发思考」：模型照常思考（质量、耗时、扣费都不变），只是思考内容不下发。 */
export async function saveHideReasoning(next: boolean): Promise<void> {
  if (busyScope) { repaint(); return }
  beginBusy('hideReasoning')
  publish({ hideReasoning: { ...snapshot.hideReasoning, on: next } })
  try {
    const saved = await bridgeOrApi('saveHideReasoning', '/api/hideReasoning', { hideReasoning: next })
    renderHideReasoning(saved)
    toast(next ? '✅ 已改为「不下发思考」' : '✅ 已恢复下发思考')
  } catch (error) {
    toast(`保存失败: ${errorMessage(error)}`, 'err')
    await loadHideReasoning() // 回滚到后端的真实值
  } finally {
    endBusy()
  }
}

export async function saveDebug(next: boolean): Promise<void> {
  // 忙碌中早退：受控开关的 checked 来自快照，不写快照即等于「还原这一下拨动」
  if (busyScope) { repaint(); return }
  beginBusy('debug')
  publish({ debug: { ...snapshot.debug, on: next } })
  try {
    const saved = await shared().workbuddyDesktop?.saveDebug(next)
    renderDebug(saved)
    toast(next ? '✅ 调试模式已开启' : '✅ 调试模式已关闭')
  } catch (error) {
    toast(`保存失败: ${errorMessage(error)}`, 'err')
    await loadDebug() // 回滚到后端的真实值
  } finally {
    endBusy()
  }
}

export function renderSanitize(data?: unknown): void {
  if (data === undefined) return
  if (!data || typeof data !== 'object') {
    publish({ sanitize: { status: 'unavailable', on: false } })
    return
  }
  const record = data as Record<string, unknown>
  publish({ sanitize: { status: 'ready', on: record.sanitizeBlacklistFingerprints === true } })
}

async function loadSanitize(): Promise<void> {
  try {
    renderSanitize(await shared().workbuddyDesktop?.getSanitize())
  } catch (error) {
    console.warn('读取出站指纹脱敏设置失败:', errorMessage(error))
    renderSanitize(null)
  }
}

export async function saveSanitize(next: boolean): Promise<void> {
  if (busyScope) { repaint(); return }
  beginBusy('sanitize')
  publish({ sanitize: { status: 'ready', on: next } })
  try {
    const saved = await shared().workbuddyDesktop?.saveSanitize(next)
    renderSanitize(saved)
    toast(next ? '✅ 出站指纹脱敏已开启' : '已关闭出站指纹脱敏')
  } catch (error) {
    toast(`保存失败: ${errorMessage(error)}`, 'err')
    await loadSanitize() // 回滚到后端的真实值
  } finally {
    endBusy()
  }
}

/* ─── 机器人校验（面板登录 / 注册的 ALTCHA 开关）── */

async function loadCaptcha(): Promise<void> {
  try {
    const state = await shared().workbuddyDesktop?.getCaptchaSetting()
    publish({ captcha: { available: true, enabled: state?.captchaEnabled === true } })
  } catch (error) {
    // 读失败降级禁用开关（照 retention 的模式）
    publish({ captcha: { available: false, enabled: false } })
    console.warn('读取机器人校验设置失败:', errorMessage(error))
  }
}

export async function saveCaptcha(next: boolean): Promise<void> {
  if (busyScope) { repaint(); return }
  beginBusy('captcha')
  publish({ captcha: { ...snapshot.captcha, enabled: next } })
  try {
    const state = await shared().workbuddyDesktop?.saveCaptchaSetting(next)
    publish({ captcha: { available: true, enabled: state?.captchaEnabled === true } })
    toast(next ? '✅ 机器人校验已开启' : '⚠️ 机器人校验已关闭')
  } catch (error) {
    toast(`保存失败：${errorMessage(error)}`, 'err')
    await loadCaptcha()
  } finally {
    endBusy()
  }
}

/* ─── 多账号调度档位 ───────────────────────── */

/**
 * 认不出的值回落默认（`creditFirst`）：与后端「认不出就用默认、不报错」同一取向
 * —— 手改坏的一个值不该让整块设置不可用。
 */
function normalizeSchedulingMode(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  return SCHEDULING_MODES.some(item => item.value === text) ? text : 'creditFirst'
}

/** 等待秒数归一：非整数 / 越界一律回落到后端默认值（30），与后端「坏值回默认」同一取向。 */
function normalizeSchedulingWait(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value < SCHEDULING_WAIT_MIN || value > SCHEDULING_WAIT_MAX) {
    return 30
  }
  return value
}

/** 桥返回的两项 → 状态里那一格（读与写共用，免得两处归一化漂移）。 */
function readScheduling(state?: {
  schedulingMode?: string
  schedulingWaitSeconds?: number
} | null): { available: boolean; mode: string; waitSeconds: number } {
  return {
    available: true,
    mode: normalizeSchedulingMode(state?.schedulingMode),
    waitSeconds: normalizeSchedulingWait(state?.schedulingWaitSeconds),
  }
}

async function loadScheduling(): Promise<void> {
  try {
    const state = await shared().workbuddyDesktop?.getSchedulingSetting()
    publish({ scheduling: readScheduling(state) })
  } catch (error) {
    // 读失败降级成只读（照 captcha 的模式）
    publish({ scheduling: { available: false, mode: 'creditFirst', waitSeconds: 30 } })
    console.warn('读取调度设置失败:', errorMessage(error))
  }
}

export async function saveSchedulingMode(mode: string): Promise<void> {
  if (busyScope) { repaint(); return }
  beginBusy('scheduling')
  publish({ scheduling: { ...snapshot.scheduling, mode } })
  try {
    const state = await shared().workbuddyDesktop?.saveScheduling({ schedulingMode: mode })
    publish({ scheduling: readScheduling(state) })
    const option = SCHEDULING_MODES.find(item => item.value === mode)
    toast(`✅ 调度已改为「${option?.toastLabel ?? mode}」`)
  } catch (error) {
    toast(`保存失败：${errorMessage(error)}`, 'err')
    await loadScheduling() // 回滚到后端的真实值
  } finally {
    endBusy()
  }
}

/** 满员等待秒数（数字行提交；0 = 不等待）。校验口径与后端一致：0–300 的整数。 */
export async function saveSchedulingWait(raw: string): Promise<void> {
  const parsed = parseInteger(raw, SCHEDULING_WAIT_MIN, SCHEDULING_WAIT_MAX, '满员等待')
  if (!parsed.ok) {
    toast(parsed.message, 'err')
    return
  }
  if (busyScope) { repaint(); return }
  beginBusy('scheduling')
  publish({ scheduling: { ...snapshot.scheduling, waitSeconds: parsed.value } })
  try {
    const state = await shared().workbuddyDesktop?.saveScheduling({
      schedulingWaitSeconds: parsed.value,
    })
    publish({ scheduling: readScheduling(state) })
    toast(parsed.value === 0 ? '✅ 已保存：满员不再等待' : `✅ 已保存：满员最多等 ${parsed.value} 秒`)
  } catch (error) {
    toast(`保存失败：${errorMessage(error)}`, 'err')
    await loadScheduling()
  } finally {
    endBusy()
  }
}

/* ─── 系统提示词（模式 + 文件 + 降级状态） ───── */

export function renderPrompt(data?: unknown): void {
  if (data === undefined) return
  if (!data || typeof data !== 'object') {
    publish({ prompt: { ...snapshot.prompt, status: 'unavailable' } })
    return
  }
  const record = data as Record<string, unknown>
  const gateway = gatewayPrompts(record.promptGateway)
  publish({
    prompt: {
      status: 'ready',
      mode: String(record.promptMode || 'passthrough'),
      file: String(record.promptFile || ''),
      text: String(record.promptText || ''),
      source: String(record.promptSource || ''),
      lines: Number(record.promptLines) || 0,
      fileError: String(record.promptFileError || ''),
      degradeActive: record.degradeActive === true,
      degradeUntilText: String(record.degradeUntilText || ''),
      providers: providerPrompts(record.promptProviders, gateway),
      gateway,
      gatewayText: gatewayTexts(record.promptGatewayText),
      options: providerOptions(record.promptProviderOptions),
    },
  })
}

/**
 * 逐家覆盖的归一化：
 * `{"<id>": {mode, promptFile, promptText, promptSource, promptLines, promptFileError}}`。
 *
 * 缺项一律给「中性默认」而不是 undefined：视图层对着这些字段直接渲染，
 * 少一个字段就少一行提示，而那正是用户排查「这家到底生效了没有」的依据。
 *
 * `gateway` 从**另一张表**（`promptGateway`）取，键缺失 = 默认装 —— 两张表在
 * 后端也是分开的（见 `KEY_PROMPT_GATEWAY`），这里保持同样的边界：
 * 「客户端 system 怎么处理」与「网关自己装什么」互不牵连。
 */
function providerPrompts(raw: unknown, gateway: Record<string, boolean>): ProviderPromptState[] {
  if (!raw || typeof raw !== 'object') return []
  return Object.entries(raw as Record<string, unknown>)
    .filter(([id, value]) => !!id && !!value && typeof value === 'object')
    .map(([id, value]) => {
      const entry = value as Record<string, unknown>
      return {
        id,
        mode: String(entry.promptMode || 'passthrough'),
        file: String(entry.promptFile || ''),
        text: String(entry.promptText || ''),
        source: String(entry.promptSource || ''),
        lines: Number(entry.promptLines) || 0,
        fileError: String(entry.promptFileError || ''),
        gateway: gateway[id] ?? true,
        configured: true,
      }
    })
    // 后端已按 id 排序（BTreeMap），这里保持原序：前端再排一次只会多一套顺序规则
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 可配置的家的清单（后端给什么就是什么，认不出的项直接丢掉 —— 宁缺勿错） */
function providerOptions(raw: unknown): ProviderPromptOption[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(item => !!item && typeof item === 'object' && String((item as Record<string, unknown>).id || ''))
    .map(item => {
      const entry = item as Record<string, unknown>
      return {
        id: String(entry.id),
        label: String(entry.label || entry.id),
        gatewayNote: String(entry.gatewayNote || ''),
        gatewayChars: Number(entry.gatewayChars) || 0,
        gatewayBlocks: gatewayBlocks(entry.gatewayBlocks),
      }
    })
}

/**
 * 网关自带提示词的开关表归一化：`{"<id>": true|false}`；认不出的项丢掉。
 *
 * 键**缺失 = 默认装**：表里只出现被明确拨过的家，界面按 `[id] ?? true` 取。
 */
function gatewayPrompts(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {}
  const flags: Record<string, boolean> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(id || '').trim()
    if (!key || typeof value !== 'boolean') continue
    flags[key] = value
  }
  return flags
}

/**
 * 网关自带提示词的**正文覆盖**归一化：`{"<id>": {identity?, stable?, dynamic?}}`。
 *
 * 只保留**真给了文本的段**：缺的段由视图层用官方原文补齐（后端也是这个口径 ——
 * 「没写这一段」就是「这段用官方原文」）。三段的段名只在这里出现一次，
 * 与后端的 `GatewayBlocks::FIELDS` 逐字对齐。
 */
function gatewayTexts(raw: unknown): Record<string, GatewayBlocks> {
  if (!raw || typeof raw !== 'object') return {}
  const table: Record<string, GatewayBlocks> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(id || '').trim()
    if (!key || !value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const blocks: GatewayBlocks = { identity: '', stable: '', dynamic: '' }
    let any = false
    for (const field of ['identity', 'stable', 'dynamic'] as const) {
      const text = String(entry[field] || '')
      blocks[field] = text
      if (text.trim()) any = true
    }
    if (any) table[key] = blocks
  }
  return table
}

/** 三段正文（配置 / 模板）的归一化；三段都没给就给 null */
function gatewayBlocks(raw: unknown): GatewayBlocks | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const blocks: GatewayBlocks = {
    identity: String(entry.identity || ''),
    stable: String(entry.stable || ''),
    dynamic: String(entry.dynamic || ''),
  }
  if (!blocks.identity.trim() && !blocks.stable.trim() && !blocks.dynamic.trim()) return null
  return blocks
}

async function loadPrompt(): Promise<void> {
  try {
    renderPrompt(await shared().workbuddyDesktop?.getPrompt())
  } catch (error) {
    console.warn('读取系统提示词设置失败:', errorMessage(error))
    renderPrompt(null)
  }
}

/**
 * 保存一个字段（模式 / 文件 / 正文）。与旧实现的一处**有意偏差**：只传变化的那一项。
 * 旧实现把两个控件的 DOM 值都带上（那是它唯一能读到「当前值」的地方）；React 这边未提交的
 * 编辑留在各自控件的草稿里，而失焦提交先于点击另一控件发生，所以不存在「漏带」，
 * 后端本来就允许部分字段（未出现的项保持原值）。
 *
 * 返回值 = 这次写入是否成功：编辑器（提示词正文那个弹窗）据此决定关不关窗 ——
 * 保存失败时留在原地，用户不必重新把整段文本再敲一遍。
 */
async function savePromptField(label: string, patch: PromptPatch): Promise<boolean> {
  if (busyScope) {
    await loadPrompt() // 有别的操作在跑：把界面拉回后端真实值，别让用户以为改了
    return false
  }
  beginBusy('prompt')
  try {
    const saved = await shared().workbuddyDesktop?.savePrompt(patch)
    renderPrompt(saved)
    toast(`✅ 已保存：${label}`)
    return true
  } catch (error) {
    toast(`保存失败: ${errorMessage(error)}`, 'err')
    await loadPrompt() // 回滚到后端的真实值
    return false
  } finally {
    endBusy()
  }
}

export async function savePromptMode(mode: string): Promise<void> {
  const option = PROMPT_MODES.find(item => item.value === mode)
  await savePromptField(`模式改为「${option?.toastLabel ?? mode}」`, { promptMode: mode })
}

export async function savePromptFile(raw: string): Promise<void> {
  await savePromptField(
    raw.trim() ? '提示词文件已更新' : '已改回内置默认提示词',
    { promptFile: raw },
  )
}

/**
 * 保存**全局提示词正文**（界面里编辑的那一份）。空文本 = 清除这一份、
 * 回落提示词文件 / 内置默认（`savePrompt` 的空串语义）。
 *
 * 保存成功返回 true，供编辑器决定是否关窗。
 */
export async function savePromptText(text: string): Promise<boolean> {
  const empty = !text.trim()
  return savePromptField(
    empty ? '已清掉界面编辑的提示词（回落文件 / 内置默认）' : '提示词正文已更新',
    { promptText: empty ? '' : text },
  )
}

/* ─── 系统提示词：按提供商 ─────────────────────── */

/** 这一家在界面上的名字（清单里查不到就回显 id —— 与后端的兜底同一取向） */
export function promptProviderLabel(prompt: PromptState, id: string): string {
  return prompt.options.find(item => item.id === id)?.label || id
}

/**
 * 校验一家 id 是否**登记在清单里**，认不出就返回空串（调用方直接什么都不做）。
 *
 * 两层防线里的第二层。第一层在视图（下拉的 `onValueChange` 刨掉 null）：Base UI
 * 的 Select 在「清空 / 取消选择」时回调 `null`，而 `String(null)` 是**字面量
 * "null"** —— 那会被当成一家叫 `null` 的提供商发给后端，后端如实回一句
 * 「未知的提供商 id：null」，用户看到的就是一次莫名其妙的保存失败。
 * 这一层则保证：不管 id 从哪儿来（旧响应、手改的数据、以后新增的调用点），
 * 未登记的家**永远发不出去** —— 与后端 `is_known_provider_id` 同一口径。
 */
function knownProviderId(id: unknown): string {
  const text = id == null ? '' : String(id).trim()
  if (!text) return ''
  return snapshot.prompt.options.some(item => item.id === text) ? text : ''
}

/** 写一家（`patch` 里未给的字段由后端保持原值） */
async function saveProviderPrompt(
  label: string,
  id: string,
  patch: { promptMode?: string; promptFile?: string; promptText?: string } | null,
): Promise<boolean> {
  return savePromptField(label, { promptProviders: { [id]: patch } })
}

/**
 * 「这一行屏幕上显示的那几个值」→ 这一家自己的覆盖（**所见即所存**）。
 *
 * 模式与文件一起落：这一行可能原本「跟随全局」（界面上显示的是全局那份），只改
 * 一个值时，另一个若不带就落到「内置默认」—— 一次改动，两个后果，第二个还看不见
 * （`saveProviderPromptMode` 早先就为这件事这么做了）。
 *
 * **正文**只在一种情况下一起落：这一行原本跟随全局、且全局那份正文本身就是
 * 「界面里编辑的」。否则给空串（= 这一家没有自己的正文）：它自己的文件 / 内置默认
 * 接管，渲染出来的仍是屏幕上那段文本（文件路径刚被一起落下来了）。反过来，若无条件
 * 把屏幕上的文本落成这一家的正文，就会把**文件内容复制进配置** —— 之后改文件不再生效，
 * 而配置里多出几百行看不出缘由的文本。
 */
function providerPatch(
  prompt: PromptState,
  item: ProviderPromptState,
): { promptMode: string; promptFile: string; promptText: string } {
  const followGlobal = !item.configured
  return {
    promptMode: item.mode,
    promptFile: item.file,
    promptText: followGlobal && prompt.source === 'inline' ? prompt.text : '',
  }
}

/** 给这一家加一条覆盖（初始值 = 全局那份：屏幕上显示的几项都照抄当前的全局值） */
export async function addProviderPrompt(rawId: string): Promise<void> {
  const id = knownProviderId(rawId)
  if (!id) return
  const prompt = snapshot.prompt
  await saveProviderPrompt(
    `已为「${promptProviderLabel(prompt, id)}」单独配置提示词`,
    id,
    providerPatch(prompt, {
      id,
      mode: prompt.mode,
      file: prompt.file,
      text: prompt.text,
      source: prompt.source,
      lines: prompt.lines,
      fileError: prompt.fileError,
      gateway: prompt.gateway[id] ?? true,
      configured: false,
    }),
  )
}

export async function saveProviderPromptMode(item: ProviderPromptState, mode: string): Promise<void> {
  const id = knownProviderId(item.id)
  if (!id || !PROMPT_MODES.some(option => option.value === mode)) return
  const option = PROMPT_MODES.find(candidate => candidate.value === mode)
  await saveProviderPrompt(
    `「${promptProviderLabel(snapshot.prompt, id)}」的模式改为「${option?.toastLabel ?? mode}」`,
    id,
    { ...providerPatch(snapshot.prompt, item), promptMode: mode },
  )
}

export async function saveProviderPromptFile(item: ProviderPromptState, raw: string): Promise<void> {
  const id = knownProviderId(item.id)
  if (!id) return
  await saveProviderPrompt(
    raw.trim()
      ? `「${promptProviderLabel(snapshot.prompt, id)}」的提示词文件已更新`
      : `「${promptProviderLabel(snapshot.prompt, id)}」改用内置默认提示词`,
    id,
    // 同上：与文件一起把当前显示的模式落定，避免「改文件把模式改回去」
    { ...providerPatch(snapshot.prompt, item), promptFile: raw },
  )
}

/**
 * 保存**某一家**的提示词正文（界面里编辑的那一份）。空文本 = 这一家清掉正文、
 * 回落它自己的文件 / 内置默认。
 *
 * 与上面两个动作同一套「所见即所存」：一次保存把这行显示的模式 / 文件 / 正文
 * 三个值一起落定，免得改正文时把另两项改回去。
 */
export async function saveProviderPromptText(
  item: ProviderPromptState,
  text: string,
): Promise<boolean> {
  const id = knownProviderId(item.id)
  if (!id) return false
  const empty = !text.trim()
  const label = promptProviderLabel(snapshot.prompt, id)
  return saveProviderPrompt(
    empty ? `已清掉「${label}」界面编辑的正文` : `「${label}」的提示词正文已更新`,
    id,
    { ...providerPatch(snapshot.prompt, item), promptText: empty ? '' : text },
  )
}

/** 删掉这一家的覆盖（回落全局设置；传 null 是后端的「删除这一家」语义） */
export async function removeProviderPrompt(rawId: string): Promise<void> {
  const id = knownProviderId(rawId)
  if (!id) return
  await saveProviderPrompt(
    `已取消「${promptProviderLabel(snapshot.prompt, id)}」的单独配置`,
    id,
    null,
  )
}

/**
 * 拨动**网关自带提示词**的开关（这一家要不要装官方那段装配）。
 *
 * 与模式 / 文件走**另一维**（`promptGateway`），理由见后端
 * `KEY_PROMPT_GATEWAY`：拨一下开关不该把这家的模式钉成显式值。
 *
 * 关掉是「用户主动放弃上游要求」的动作：只在明确关掉时提示后果，打开时
 * 提示语是普通的中性文案 —— 对着一件恢复正常的事喊警告只会让人脱敏。
 */
export async function saveProviderGatewayPrompt(rawId: string, enabled: boolean): Promise<void> {
  const id = knownProviderId(rawId)
  if (!id) return
  const label = promptProviderLabel(snapshot.prompt, id)
  if (busyScope) {
    await loadPrompt()
    return
  }
  beginBusy('prompt')
  try {
    const saved = await shared().workbuddyDesktop?.savePrompt({ promptGateway: { [id]: enabled } })
    renderPrompt(saved)
    toast(
      enabled
        ? `✅ 已为「${label}」装上网关自带提示词`
        : `已关闭「${label}」的网关自带提示词：能否通过上游校验取决于上游当前口径`,
      enabled ? 'ok' : 'err',
    )
  } catch (error) {
    toast(`保存失败：${errorMessage(error)}`, 'err')
    await loadPrompt() // 回滚到后端的真实值
  } finally {
    endBusy()
  }
}

/**
 * 保存**某一家**的网关自带提示词**正文**（三段一起提交；`null` = 回到官方原文）。
 *
 * 与开关（`saveProviderGatewayPrompt`）走**另一维**（`promptGatewayText`）：
 * 改文本不该顺带把开关拨回去 —— 用户在编辑框里清掉自己那段、想回到官方原文时，
 * 更不该连「装不装」也一起变。
 *
 * 三段一起传是有意的：它们是一个整体（上游认的是「三段各自成块」这个形状），
 * 编辑器里也是三段并排显示，保存时按屏幕上看到的那份原样落下来。
 * 保存成功返回 true，供编辑器决定是否关窗。
 */
export async function saveProviderGatewayText(
  rawId: string,
  blocks: GatewayBlocks | null,
): Promise<boolean> {
  const id = knownProviderId(rawId)
  if (!id) return false
  const label = promptProviderLabel(snapshot.prompt, id)
  // 三段全空白 = 没有覆盖（后端也是这个口径：空段不落盘、三段全空就把这家删掉）。
  // 归一成 `null` 只是为了提示语说得准：用户清空了三段，看到的是「已改回官方原文」。
  const emptied = !blocks
    || !(blocks.identity.trim() || blocks.stable.trim() || blocks.dynamic.trim())
  return savePromptField(
    emptied ? `「${label}」的网关自带提示词已改回官方原文` : `「${label}」的网关自带提示词正文已更新`,
    { promptGatewayText: { [id]: emptied ? null : blocks } },
  )
}

/** 立即解除降级（后端把状态机清零；配置项一个都不动） */
export async function clearDegrade(): Promise<void> {
  if (busyScope) return
  beginBusy('prompt')
  try {
    const saved = await shared().workbuddyDesktop?.savePrompt({ clearDegrade: true })
    renderPrompt(saved)
    toast('✅ 已解除内容拦截降级')
  } catch (error) {
    toast(`解除失败: ${errorMessage(error)}`, 'err')
    await loadPrompt()
  } finally {
    endBusy()
  }
}

/* ─── 数据存储概况（只读） ─────────────────── */

/** 数值归一：非有限数一律 null（视图据此显示「—」） */
function finiteOrNull(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 渲染概况。形状是后端的**单库语义**：
 * `{ configDir, database: { file, bytes, available, accounts, logs, requests, dailyDays, debug } }`。
 * 后端起不来（网络 / 桥失败）与库打不开是两件事，但对这一页的结论相同：读不到存储概况就
 * 展示「不可用」而不是一排看着正常的 0。
 */
export function renderStorage(data?: unknown): void {
  if (data === undefined) return
  const info = data && typeof data === 'object'
    ? (data as Record<string, unknown>).database
    : null
  if (!info || typeof info !== 'object') {
    publish({ storage: { ...snapshot.storage, status: 'unavailable' } })
    return
  }
  const record = info as Record<string, unknown>
  publish({
    storage: {
      status: 'ready',
      available: record.available !== false,
      file: String(record.file || ''),
      bytes: Number(record.bytes) || 0,
      accounts: finiteOrNull(record.accounts),
      logs: finiteOrNull(record.logs),
      requests: finiteOrNull(record.requests),
      dailyDays: finiteOrNull(record.dailyDays),
      debug: finiteOrNull(record.debug),
    },
  })
}

async function loadStorage(): Promise<void> {
  try {
    renderStorage(await shared().workbuddyDesktop?.getStorage())
  } catch (error) {
    console.warn('读取数据存储概况失败:', errorMessage(error))
    renderStorage(null)
  }
}

/* ─── 面板登录（仅网页端） ─────────────────── */

/**
 * 「退出登录」撤销本设备的整条会话链（30 天自动续期一并失效），其他已登录设备不受影响；
 * 成功后整页跳回登录页。返回 false 表示失败（按钮要解禁）。
 */
export async function panelLogout(): Promise<boolean> {
  try {
    await shared().workbuddyDesktop?.panelLogout()
    window.location.href = '/login'
    return true
  } catch (error) {
    toast(`退出失败：${errorMessage(error)}`, 'err')
    return false
  }
}

/* ─── 加载入口 ─────────────────────────────── */

/**
 * 设置页数据入口（app.js 切入该页时调用，upgrade-panel 迁移完成后也调）。
 * 九个取数并行，各自失败各自降级 —— 一个接口挂了不该把整页拖成空白。
 */
export async function load(): Promise<void> {
  restoreCategory()
  renderUnits()
  publish({ panelLogin: readPanelLogin() })
  await Promise.all([
    loadSettings(),
    loadRetention(),
    loadRetry(),
    loadTimeouts(),
    loadQueue(),
    loadDebug(),
    loadHideReasoning(),
    loadForwardMode(),
    loadCodeartsCap(),
    loadWelfareSettings(),
    loadCodeartsThinking(),
    loadSanitize(),
    loadPrompt(),
    loadStorage(),
    loadCaptcha(),
    loadScheduling(),
    // 软件更新面板是另一个岛（update-panel.tsx），切进设置页时让它自己刷新一次
    shared().wbUpdatePanel?.load?.(),
  ])
}

/* ─── 刷新按钮（各自的 toast 文案照旧） ─────── */

export async function refreshRetention(): Promise<void> {
  await loadRetention()
  toast('保留天数已刷新')
}

export async function refreshRetry(): Promise<void> {
  await loadRetry()
  toast('重试设置已刷新')
}

export async function refreshTimeouts(): Promise<void> {
  await loadTimeouts()
  toast('超时设置已刷新')
}

export async function refreshQueue(): Promise<void> {
  await loadQueue()
  toast('排队等待设置已刷新')
}

export async function refreshDebug(): Promise<void> {
  await loadDebug()
  toast('调试模式设置已刷新')
}

export async function refreshSanitize(): Promise<void> {
  await loadSanitize()
  toast('指纹脱敏设置已刷新')
}

export async function refreshPrompt(): Promise<void> {
  await loadPrompt()
  toast('系统提示词设置已刷新')
}

export async function refreshStorage(): Promise<void> {
  await loadStorage()
  toast('存储概况已刷新')
}
