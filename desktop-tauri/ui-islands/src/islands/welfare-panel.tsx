/**
 * 「福利」页：把「领福利」从账号行上的弹窗升级成一张**跨账号总览**。
 *
 * ── 为什么要单独一页（对照 WorkBuddy2API 面板的三张卡）────────
 * 参考面板上有「任务记录 / 服务端任务盘点 / 活动与奖励」三块，回答的是三个不同问题：
 * 调度跑得怎么样、上游下发了哪些任务、每个账号能领什么。本页把后两个问题收成一块：
 * **一个账号一行，行里列出上游当前下发的活动与它的领取状态**，外加顶部那条自动任务的
 * 开关。第一块（「上次什么时候跑的」）由「定时任务」页那张卡回答，不在这里重复。
 *
 * ── 探测与领取是两件事，界面上必须分开 ───────────────────────
 * 探测（`…/codearts-welfare/preview`）是<strong>只读</strong>的：点多少次都不会消耗领取机会，
 * 所以「探测全部」可以随手点。领取（`…/codearts-welfare`）是**外部服务的写操作** ——
 * 点一下，这个账号当天的领取机会就少一次，因此每个账号单独一个按钮、单独确认。
 * 这条分工是既有实现（`ui/codearts-welfare.js`）就定下的，本页沿用。
 *
 * ── 为什么走 `api_request` 这条通用桥 ────────────────────────
 * 福利那两个端点没有具名桥方法（具名方法要同时改 web_shim 与桌面壳两处），
 * 而壳本来就暴露了通用入口 `api_request`（`ui/codearts-welfare.js` 用的就是它）。
 * 复用它可以做到**只加一个前端文件**，不碰后端、不碰桥。
 *
 * ── 与弹窗那条路的关系 ──────────────────────────────────────
 * 账号行上的「领福利」弹窗照旧可用，两条路调的是**同一组接口**，不重复实现领取逻辑。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'

import { Button, Input, Switch } from '@ui'

import { describeError, shared, toast } from './add-account-bridge'
import { CheckinHistoryDialog } from './checkin-history-dialog'

declare global {
  interface Window {
    wbWelfarePanel?: { load: () => void }
  }
}

/* ─── 数据形状（与后端 / 既有弹窗逐字对齐）─────────────────── */

type Campaign = {
  kind?: string
  autoClaim?: boolean
  benefitAmount?: number
  benefitUnit?: string
  confirmed?: boolean
  localClaimed?: boolean
  claimable?: boolean
  status?: string
  name?: string
  id?: string
}

type Preview = {
  campaigns?: Campaign[]
  /** 全量活动清单（只读）：面板「探测」要展示的完整列表，见后端 welfare::preview */
  allCampaigns?: Campaign[]
  attempts?: number
  attemptsLeft?: number
  nextAttemptInMs?: number
  day?: string
}

type Account = { id: string; name?: string; provider?: string; enabled?: boolean }

type IntervalTask = {
  id: string
  label: string
  enabled: boolean
  interval: number
  min: number
  max: number
  lastResult?: string | null
  lastSuccessAt?: number | null
  nextRunAt?: number | null
  canRun?: boolean
}

const WELFARE_TASK_ID = 'codeartsWelfare'

/** 福利节流三个旋钮（`GET/PUT /api/welfareSettings`，2026-10-07）。
 *
 * 与上面那个「间隔」不是一回事：那个是**任务扫描周期**（多久看一次资格），
 * 这三个是**一轮里怎么发写请求** —— ② 账号之间隔多久 ③ 单账号写闸（间隔 + 每日上限）。 */
type WelfareLimits = {
  welfareAccountGapMinutes: number
  welfareMinAttemptGapMinutes: number
  welfareMaxAttemptsPerDay: number
}
type WelfareLimitKey = keyof WelfareLimits
const WELFARE_LIMITS: Record<
  WelfareLimitKey,
  { label: string; unit: string; min: number; max: number; hint: string }
> = {
  welfareAccountGapMinutes: {
    label: '账号之间的间隔',
    unit: '分钟',
    min: 0,
    max: 1440,
    hint: '领完一个账号隔多久再领下一个（0 = 不等待）',
  },
  welfareMinAttemptGapMinutes: {
    label: '单账号写闸·间隔',
    unit: '分钟',
    min: 1,
    max: 1440,
    hint: '同一账号两次写至少隔多久',
  },
  welfareMaxAttemptsPerDay: {
    label: '单账号写闸·每日上限',
    unit: '次',
    min: 1,
    max: 100,
    hint: '同一账号一天最多写几次',
  },
}
const WELFARE_LIMIT_KEYS = Object.keys(WELFARE_LIMITS) as WelfareLimitKey[]

function limitsToDrafts(limits: WelfareLimits | null): Record<WelfareLimitKey, string> {
  return {
    welfareAccountGapMinutes: String(limits?.welfareAccountGapMinutes ?? 10),
    welfareMinAttemptGapMinutes: String(limits?.welfareMinAttemptGapMinutes ?? 10),
    welfareMaxAttemptsPerDay: String(limits?.welfareMaxAttemptsPerDay ?? 6),
  }
}

/**
 * 福利页的提供商 tab。
 *
 * 现在只有码道一家 —— **但结构先留好**：后续接入别家（WorkBuddy 签到、
 * Qoder 活动…）只需往这个数组里加一项、并在下面的渲染里加对应分支，
 * 不用再动页面骨架。`available: false` 的 tab 先不显示（避免点进去是空的）。
 */
const WELFARE_TABS = [
  { id: 'codearts', label: '码道', available: true },
  { id: 'trae', label: 'Trae', available: true },
] as const

type WelfareTabId = (typeof WELFARE_TABS)[number]['id']

/* ─── Trae 每日签到（2026-10-09）─────────────────────────────── */

type TraeAccountStatus = {
  name: string
  uid: string
  /** already / success / pending / fail（见后端 checkin::AccountOutcome） */
  status: string
  credits: number | null
  delta: number
  message: string
  errorType: string | null
}

type TraeStatus = {
  traeCheckinGapMinutes: number
  /** 定点时刻 HH:MM（2026-10-10 加；与「间隔」并存） */
  traeCheckinTime?: string
  accounts: TraeAccountStatus[]
  error?: string
}

const TRAE_STATUS_TEXT: Record<string, string> = {
  already: '今日已签',
  success: '刚签到',
  pending: '未签到',
  fail: '失败',
}

/**
 * 本岛用到的桥方法（**各岛自己声明自己用的那几个**，与 tasks-panel 同一约定）：
 * 共享的 `SharedWindow` 只列公共面，具名桥方法按岛就地声明，避免每加一个页面
 * 就去改公共类型、把无关文件拖进同一次改动。
 */
type WelfareBridge = {
  getScheduledTasks?(): Promise<{ tasks?: IntervalTask[] } | null | undefined>
  saveScheduledTask?(id: string, patch: Record<string, unknown>): Promise<IntervalTask>
  runScheduledTask?(
    id: string,
  ): Promise<{ task?: IntervalTask; summary?: string } | null | undefined>
}

function tasksBridge(): WelfareBridge {
  return (shared().workbuddyDesktop ?? {}) as unknown as WelfareBridge
}

/** 账号页的余额快照同步入口（领到积分后要立刻应用，否则用户看到的是旧数字） */
type AccountsView = { syncBalancesSnapshot?(): unknown }

function accountsView(): AccountsView {
  const holder = shared() as unknown as { wbAccountsView?: AccountsView }
  return holder.wbAccountsView ?? {}
}

/* ─── 通用管理请求（与 ui/codearts-welfare.js 同一口径）─────── */

type TauriInternals = { invoke?: (command: string, args: unknown) => Promise<unknown> }

function bridgeInvoke(): TauriInternals['invoke'] {
  const holder = window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  const invoke = holder.__TAURI_INTERNALS__?.invoke
  return typeof invoke === 'function' ? invoke : undefined
}

/** 桥返回的是信封（`{data: …}`）还是内层值，两种都兜住 */
function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data
  }
  return payload as T
}

async function manage<T>(method: string, path: string, body?: unknown): Promise<T> {
  const invoke = bridgeInvoke()
  if (!invoke) throw new Error('桥未初始化（页面还没加载完，或不是桌面/网页面板形态）')
  return unwrap<T>(await invoke('api_request', { request: { method, path, body } }))
}

/* ─── 展示辅助 ─────────────────────────────────────────────── */

/** 「3 小时前」那种相对时间（对照参考面板的观感） */
function agoText(at?: number | null): string {
  if (!at) return '未执行'
  const delta = Date.now() - at
  if (delta < 0) return '刚刚'
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

/** 一条活动的状态 → 徽标。上游原码保留在 title 里，排障时对得上。 */
function campaignBadge(item: Campaign): { text: string; tone: string } {
  if (item.confirmed) return { text: '已到账', tone: 'ok' }
  if (item.localClaimed) return { text: '已领取，等确认', tone: 'warn' }
  if (item.claimable) return { text: '可领取', tone: 'warn' }
  // 上游对「还没做完前置任务」的活动既不给 claimable、也不给 status
  // （实测 6 条里有 5 条如此：下载 IDE 对话、邀请、学生认证…）——
  // 这时说「不可领（未知）」既难读又像出错，改成中性的「暂不可领」。
  if (!item.status) return { text: '暂不可领', tone: '' }
  return { text: `不可领（${item.status}）`, tone: '' }
}

function campaignLabel(item: Campaign): string {
  const amount = Number(item.benefitAmount) || 0
  const unit = item.benefitUnit || '积分'
  return `${amount} ${unit}`
}

/* ─── 页面 ─────────────────────────────────────────────────── */

function WelfarePage(): React.ReactElement {
  const [accounts, setAccounts] = React.useState<Account[]>([])
  const [previews, setPreviews] = React.useState<Record<string, Preview>>({})
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [task, setTask] = React.useState<IntervalTask | null>(null)
  const [intervalDraft, setIntervalDraft] = React.useState('')
  const [probing, setProbing] = React.useState(false)
  const [claiming, setClaiming] = React.useState('')
  const [taskBusy, setTaskBusy] = React.useState(false)
  const [tab, setTab] = React.useState<WelfareTabId>('codearts')
  /** 福利节流三个旋钮（读失败时 null → 输入框禁用） */
  const [limits, setLimits] = React.useState<WelfareLimits | null>(null)
  const [limitDrafts, setLimitDrafts] = React.useState<Record<WelfareLimitKey, string>>(
    limitsToDrafts(null),
  )
  const [limitsBusy, setLimitsBusy] = React.useState(false)

  /** 只读探测：一个账号一次 preview，互不影响（单账号失败只记在自己的行上） */
  const probeAll = React.useCallback(async (list: Account[]) => {
    setProbing(true)
    const next: Record<string, Preview> = {}
    const failed: Record<string, string> = {}
    await Promise.all(
      list.map(async account => {
        try {
          next[account.id] = await manage<Preview>(
            'POST',
            `/api/accounts/${encodeURIComponent(account.id)}/codearts-welfare/preview`,
            {},
          )
        } catch (error) {
          failed[account.id] = describeError(error)
        }
      }),
    )
    setPreviews(next)
    setErrors(failed)
    setProbing(false)
  }, [])

  const load = React.useCallback(async () => {
    try {
      const snapshot = await manage<{ accounts?: Account[] }>('GET', '/api/accounts')
      const list = (snapshot?.accounts || []).filter(item => item.provider === 'codearts')
      setAccounts(list)
      const tasks = await tasksBridge().getScheduledTasks?.()
      const found = (tasks?.tasks || []).find(item => item.id === WELFARE_TASK_ID) || null
      setTask(found)
      if (found) setIntervalDraft(String(found.interval))
      const limitsSnapshot = await manage<WelfareLimits>('GET', '/api/welfareSettings')
      setLimits(limitsSnapshot)
      setLimitDrafts(limitsToDrafts(limitsSnapshot))
      await probeAll(list)
    } catch (error) {
      toast(`加载福利页失败：${describeError(error)}`, 'err')
    }
  }, [probeAll])

  // 与 tasks-panel 同一形态：切到本页时由 app.js 调 load()；
  // 首屏若已经停在本页（刷新页面），脚本加载时自己跑一次。
  React.useEffect(() => {
    void load()
  }, [load])

  async function saveTask(patch: { enabled?: boolean; interval?: number }): Promise<void> {
    if (taskBusy || !task) return
    setTaskBusy(true)
    try {
      const saved = await tasksBridge().saveScheduledTask?.(WELFARE_TASK_ID, patch)
      if (saved) {
        setTask(saved)
        setIntervalDraft(String(saved.interval))
      }
      toast('✅ 自动领福利设置已保存')
    } catch (error) {
      toast(`保存失败：${describeError(error)}`, 'err')
    } finally {
      setTaskBusy(false)
    }
  }

  /** 保存一个节流旋钮：三个值一起 PUT（后端要求给全，不做部分更新）。 */
  async function saveLimit(key: WelfareLimitKey, raw: string): Promise<void> {
    if (limitsBusy || !limits) return
    const spec = WELFARE_LIMITS[key]
    const value = Number(raw)
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
      toast(`${spec.label}必须是 ${spec.min} 到 ${spec.max} 的整数`, 'err')
      return
    }
    const merged = limitsToDrafts(limits)
    const next: WelfareLimits = {
      welfareAccountGapMinutes: Number(key === 'welfareAccountGapMinutes' ? value : merged.welfareAccountGapMinutes),
      welfareMinAttemptGapMinutes: Number(key === 'welfareMinAttemptGapMinutes' ? value : merged.welfareMinAttemptGapMinutes),
      welfareMaxAttemptsPerDay: Number(key === 'welfareMaxAttemptsPerDay' ? value : merged.welfareMaxAttemptsPerDay),
    }
    setLimitsBusy(true)
    try {
      const saved = await manage<WelfareLimits>('PUT', '/api/welfareSettings', next)
      setLimits(saved)
      setLimitDrafts(limitsToDrafts(saved))
      toast(`✅ 已保存：账号之间 ${next.welfareAccountGapMinutes} 分钟、单账号写闸 ${next.welfareMinAttemptGapMinutes} 分钟 / 每天 ${next.welfareMaxAttemptsPerDay} 次`)
    } catch (error) {
      toast(`保存失败：${describeError(error)}`, 'err')
      await load()
    } finally {
      setLimitsBusy(false)
    }
  }

  async function runTaskNow(): Promise<void> {
    if (taskBusy) return
    setTaskBusy(true)
    try {
      const result = await tasksBridge().runScheduledTask?.(WELFARE_TASK_ID)
      if (result?.task) setTask(result.task)
      toast(`✅ 自动领福利：${result?.summary || '已执行'}`)
      // 领到的是套餐赠送积分：账号页那个数字当场就变了，顺手刷新一次
      await shared().wbApp?.refresh?.()
      await accountsView().syncBalancesSnapshot?.()
      await probeAll(accounts)
    } catch (error) {
      toast(`执行失败：${describeError(error)}`, 'err')
    } finally {
      setTaskBusy(false)
    }
  }

  /** 单个账号领取（写操作：点了就消耗当天的一次机会，所以逐个确认） */
  async function claim(account: Account): Promise<void> {
    if (claiming) return
    const label = account.name || account.id
    setClaiming(account.id)
    try {
      const result = await manage<{ outcome?: string; confirmed?: boolean }>(
        'POST',
        `/api/accounts/${encodeURIComponent(account.id)}/codearts-welfare`,
        {},
      )
      toast(`✅ ${label}：${result?.confirmed ? '官方已确认到账' : '已提交领取'}`)
      await shared().wbApp?.refresh?.()
      await accountsView().syncBalancesSnapshot?.()
      await probeAll(accounts)
    } catch (error) {
      toast(`${label} 领取失败：${describeError(error)}`, 'err')
    } finally {
      setClaiming('')
    }
  }

  const claimable = (preview?: Preview): number =>
    (preview?.campaigns || []).filter(item => item.claimable && !item.confirmed).length

  const tabs = WELFARE_TABS.filter(item => item.available)

  return (
    <div className='flex flex-col gap-4'>
      {/* 提供商 tab：现在只有码道；加别家时往 WELFARE_TABS 里加一项即可。
          只有一个 tab 也显示（2026-10-07 用户要求）：它标明了「这块内容属于哪一家」，
          以后加别家就是并列的第二个 tab，位置不跳。 */}
      {tabs.length > 0 ? (
        <div className='flex items-center gap-1 border-b border-border'>
          {tabs.map(item => (
            <button
              key={item.id}
              type='button'
              className={`-mb-px cursor-pointer border-b-2 px-3 py-1.5 text-[13px] ${
                tab === item.id
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-subtle hover:text-foreground'
              }`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {tab === 'codearts' ? (
        <>
      {/* ── 自动领福利 ── */}
      <section className='panel'>
        <div className='panel-head'>
          <h2>自动领福利（码道）</h2>
          <div className='head-actions'>
            <Button variant='outline' disabled={probing} onClick={() => void probeAll(accounts)}>
              {probing ? '探测中…' : '探测全部'}
            </Button>
            <Button disabled={taskBusy || !task?.canRun} onClick={() => void runTaskNow()}>
              {taskBusy ? '执行中…' : '立即执行'}
            </Button>
          </div>
        </div>
        <div className='panel-body'>
          <p className='detail'>
            「探测全部」是<strong>只读</strong>的：它只问上游「现在有哪些活动、每个账号领没领」，
            不会消耗任何领取机会，可以随手点。真正的领取是<strong>写操作</strong>，按账号单独点「领取」。
          </p>
          {/* 开关与间隔**在本页改**（2026-10-10 用户明确要求）——
              「自动领福利（码道）」「自动签到（Trae）」这两条渠道级任务已从「定时任务」页
              移出，本页是它们唯一的配置入口（那边只看得到系统级 / 页面级任务）。 */}
          <div className='flex flex-wrap items-center gap-3'>
            <label className='flex items-center gap-2 text-[13px]'>
              <Switch
                checked={Boolean(task?.enabled)}
                aria-label='自动领福利开关'
                onCheckedChange={next => void saveTask({ enabled: next === true })}
              />
              自动领取
            </label>
            <label className='flex items-center gap-2 text-[13px]'>
              间隔
              <Input
                type='number'
                className='max-w-[90px]'
                value={intervalDraft}
                onChange={event => setIntervalDraft(event.target.value)}
              />
              分钟
            </label>
            <Button
              variant='outline'
              disabled={taskBusy || !task || String(task.interval) === intervalDraft}
              onClick={() => void saveTask({ interval: Number(intervalDraft) })}
            >
              保存间隔
            </Button>
          </div>
          <p className='detail mt-1'>
            上次：{task?.lastResult || '未执行'}（{agoText(task?.lastSuccessAt)}）
            {task?.nextRunAt ? ` · 下次 ${agoText(task.nextRunAt).replace('前', '后')}` : ''}
          </p>
          <p className='detail'>
            间隔只决定「多久看一次资格」；真正发写请求的次数由本地台账兜住
            （每天最多 6 次、间隔至少 10 分钟），所以调小不会把上游打多。
          </p>
          {/* 节流三旋钮（2026-10-07）：与上面那个「间隔」不是一回事 —— 那个管
              「多久看一次」，这三个管「一轮里怎么发写请求」。 */}
          <div className='mt-3 flex flex-col gap-2'>
            {WELFARE_LIMIT_KEYS.map(key => {
              const spec = WELFARE_LIMITS[key]
              return (
                <div key={key} className='flex flex-wrap items-center gap-2 text-[13px]'>
                  <span className='w-[124px] shrink-0'>{spec.label}</span>
                  <Input
                    type='number'
                    min={spec.min}
                    max={spec.max}
                    className='max-w-[90px]'
                    disabled={limits === null}
                    value={limitDrafts[key]}
                    onChange={event =>
                      setLimitDrafts(prev => ({ ...prev, [key]: event.target.value }))
                    }
                  />
                  <span className='text-subtle'>{spec.unit}</span>
                  <Button
                    variant='outline'
                    disabled={limitsBusy || limits === null}
                    onClick={() => void saveLimit(key, limitDrafts[key])}
                  >
                    保存
                  </Button>
                  <span className='text-subtle'>{spec.hint}</span>
                </div>
              )
            })}
          </div>
          <p className='detail mt-1'>
            ② <strong>账号之间的间隔</strong>：领完一个账号隔多久再领下一个 —— 防「同 IP 一口气把多个账号的写请求打完」；
            ③ <strong>单账号写闸</strong>：同一个账号两次写至少隔多久、一天最多写几次。
            两者都只约束<strong>自动</strong>领取，行内那颗「领取」按钮随时可手动领。
          </p>
        </div>
      </section>

      {/* ── 账号 × 活动 ── */}
      <section className='panel'>
        <div className='panel-head'>
          <h2>各账号福利</h2>
          <span className='detail'>
            {accounts.length} 个码道账号
            {probing ? ' · 探测中…' : ` · 现在可领 ${accounts.reduce((sum, a) => sum + claimable(previews[a.id]), 0)} 项`}
          </span>
        </div>
        <div className='panel-body'>
          {accounts.length === 0 ? (
            <p className='detail'>还没有码道账号。先去「账号」页添加。</p>
          ) : (
            <div className='flex flex-col gap-3'>
              {accounts.map(account => {
                const preview = previews[account.id]
                // 展示**全量**活动（后端 allCampaigns）：客户端「活动福利」那一列有 6 条，
                // 只显示「该自动领的」那一类会让人以为别的活动没了。老后端没有这个字段时
                // 退回 campaigns（不会空白）。
                const campaigns = preview?.allCampaigns || preview?.campaigns || []
                const failure = errors[account.id]
                return (
                  <div key={account.id} className='rounded-lg border border-border p-3'>
                    <div className='flex flex-wrap items-center gap-3'>
                      <b className='text-[13px]'>{account.name || account.id}</b>
                      {failure ? (
                        <span className='badge bad'>探测失败</span>
                      ) : (
                        <span className={`badge ${claimable(preview) > 0 ? 'warn' : ''}`}>
                          {claimable(preview) > 0 ? `${claimable(preview)} 项可领` : '暂无可领'}
                        </span>
                      )}
                      {account.enabled === false ? <span className='badge'>已禁用</span> : null}
                      <div className='ml-auto flex items-center gap-2'>
                        <Button
                          variant='outline'
                          disabled={probing}
                          onClick={() => void probeAll([account])}
                        >
                          探测
                        </Button>
                        <Button
                          disabled={claiming === account.id}
                          onClick={() => void claim(account)}
                        >
                          {claiming === account.id ? '领取中…' : '领取'}
                        </Button>
                      </div>
                    </div>
                    {failure ? (
                      <p className='detail text-destructive'>{failure}</p>
                    ) : (
                      <>
                        <p className='detail mt-1'>
                          今天（北京时间 {preview?.day || '—'}）已试 {preview?.attempts ?? 0} 次，
                          还能试 {preview?.attemptsLeft ?? 0} 次
                          {preview?.nextAttemptInMs
                            ? `，最快 ${Math.ceil(preview.nextAttemptInMs / 60000)} 分钟后可再试`
                            : ''}
                        </p>
                        {/* 活动做成 chip：一眼看清有几项、各自什么状态。
                            `list-none pl-0` 是必须的 —— 默认 ul 有左内边距，
                            会让活动比账号名缩进一截，看着像没对齐。 */}
                        <ul className='mt-2 flex list-none flex-wrap gap-2 pl-0'>
                          {campaigns.length === 0 ? (
                            <li className='detail'>没有可自动领的活动</li>
                          ) : (
                            campaigns.map((item, index) => {
                              const badge = campaignBadge(item)
                              return (
                                <li
                                  key={`${account.id}-${index}`}
                                  className='flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[13px]'
                                  title={item.status || ''}
                                >
                                  {item.name ? <b>{item.name}</b> : null}
                                  <b>{campaignLabel(item)}</b>
                                  <span className={`badge ${badge.tone}`}>{badge.text}</span>
                                  {item.autoClaim ? (
                                    <span className='detail'>可自动领</span>
                                  ) : (
                                    <span className='detail'>{item.kind || ''}</span>
                                  )}
                                </li>
                              )
                            })
                          )}
                        </ul>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <p className='detail'>
            领到的是<strong>套餐赠送积分</strong>，不会增加福利模型的 token 池；领取按账号计，
            官方确认到账后本机会不再重复领。
          </p>
        </div>
      </section>
        </>
      ) : (
        <TraeCheckinPanel />
      )}
    </div>
  )
}

/* ─── 挂载：接管 index.html 里那个空 section（与 tasks-panel 同一形态）── */

const PAGE_SELECTOR = 'section.page[data-page="welfare"]'
let mounted = false

function mount(): void {
  if (mounted) return
  const section = document.querySelector<HTMLElement>(PAGE_SELECTOR)
  if (!section) return
  mounted = true
  // 骨架里的静态子节点由下面的 JSX 按同样的类名重新渲染，留着会与 React 接管打架
  section.replaceChildren()
  createRoot(section).render(<WelfarePage />)
}

window.wbWelfarePanel = { load: mount }

// 脚本排在页面骨架之后（index.html 里 islands/ui.js 在各 section 之后），正常直接挂；
// 万一将来被挪到前面，退化成等 DOM 解析完再挂。
if (document.querySelector(PAGE_SELECTOR)) mount()
else document.addEventListener('DOMContentLoaded', mount, { once: true })

/**
 * Trae 签到卡片。
 *
 * 状态一律**实时读上游**（`GET /api/traeCheckin` 逐账号发一个只读预检）——
 * 「今天签没签」只有上游知道，本地台账会漂。手动签到走**任务触发端点**
 * （`POST /api/scheduled-tasks/traeCheckin/run`），与自动签到共用同一段代码 ——
 * 另开一条手动路径迟早会出现「手动能签、自动不能」的分叉，那种问题最难查。
 */
function TraeCheckinPanel(): React.ReactElement {
  const [data, setData] = React.useState<TraeStatus | null>(null)
  const [gapDraft, setGapDraft] = React.useState('10')
  const [timeDraft, setTimeDraft] = React.useState('09:00')
  const [busy, setBusy] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  // 签到历史弹窗（2026-10-16）：入口放在这一页 —— 用户问「签到不了」时就是
  // 在这一屏上看到「未签到」的，历史放在同一个地方最省事
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [note, setNote] = React.useState('')

  const load = React.useCallback(async () => {
    try {
      const payload = await manage<TraeStatus>('GET', '/api/traeCheckin')
      setData(payload)
      setGapDraft(String(payload.traeCheckinGapMinutes ?? 10))
      setTimeDraft(payload.traeCheckinTime || '09:00')
      setNote(payload.error ? `读取账号列表失败：${payload.error}` : '')
    } catch (error) {
      setNote(`读取失败：${describeError(error)}`)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  async function saveGap(): Promise<void> {
    const value = Number(gapDraft)
    if (!Number.isInteger(value) || value < 0 || value > 1440) {
      setNote('账号间隔必须是 0 到 1440 的整数（分钟）')
      return
    }
    setBusy(true)
    try {
      await manage('PUT', '/api/traeCheckin', { traeCheckinGapMinutes: value })
      setNote(`已保存：账号之间隔 ${value} 分钟`)
      await load()
    } catch (error) {
      setNote(`保存失败：${describeError(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 保存定点时刻（HH:MM）。与「账号之间的间隔」是两个独立的保存动作。 */
  async function saveTime(): Promise<void> {
    const text = timeDraft.trim()
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
      setNote('签到时刻要填 HH:MM（00:00-23:59），例如 09:00')
      return
    }
    setBusy(true)
    try {
      await manage('PUT', '/api/traeCheckin', { traeCheckinTime: text })
      setNote(`已保存：每天 ${text} 定点签到（间隔轮仍会兜底）`)
      await load()
    } catch (error) {
      setNote(`保存失败：${describeError(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function runNow(): Promise<void> {
    setRunning(true)
    setNote('签到中…（需要签的账号之间会按上面的间隔逐个进行）')
    try {
      const result = await manage<{ summary?: string }>(
        'POST',
        '/api/scheduled-tasks/traeCheckin/run',
      )
      setNote(result?.summary ? `本轮结果：${result.summary}` : '本轮已完成')
      await load()
    } catch (error) {
      setNote(`签到失败：${describeError(error)}`)
    } finally {
      setRunning(false)
    }
  }

  const accounts = data?.accounts ?? []

  return (
    <section className='panel'>
      <div className='panel-head'>
        <h2>自动签到（Trae）</h2>
        <div className='head-actions'>
          <Button variant='outline' onClick={() => setHistoryOpen(true)}>
            签到历史
          </Button>
          <Button variant='outline' disabled={busy || running} onClick={() => void load()}>
            刷新状态
          </Button>
          <Button disabled={running} onClick={() => void runNow()}>
            {running ? '签到中…' : '立即签到'}
          </Button>
        </div>
      </div>
      <div className='panel-body'>
        <p className='detail'>
          签到每天只有一次有效，所以「多久扫一轮」只决定<strong>多快发现可以签了</strong> ——
          已签的账号只花一个只读预检，不会重复写上游。定时任务在「定时任务」页
          （默认 6 小时一轮，可改）。
        </p>

        {accounts.length === 0 ? (
          <p className='detail'>还没有 Trae 账号。先去「账号」页添加。</p>
        ) : (
          <div className='flex flex-col gap-1'>
            {accounts.map(item => (
              <div
                key={item.uid || item.name}
                className='flex flex-wrap items-center gap-3 text-[13px]'
              >
                <span className='w-[160px] shrink-0'>{item.name}</span>
                <span className='w-[72px] shrink-0'>
                  {TRAE_STATUS_TEXT[item.status] ?? item.status}
                </span>
                <span className='text-subtle'>
                  {item.credits === null ? '积分 —' : `积分 ${item.credits}`}
                  {item.delta > 0 ? `（本轮 +${item.delta}）` : ''}
                </span>
                {item.message ? <span className='text-subtle'>{item.message}</span> : null}
              </div>
            ))}
          </div>
        )}

        <div className='mt-3 flex flex-wrap items-center gap-2 text-[13px]'>
          <span className='w-[124px] shrink-0'>签到时刻</span>
          <Input
            type='time'
            className='max-w-[130px]'
            value={timeDraft}
            disabled={busy}
            onChange={event => setTimeDraft(event.target.value)}
          />
          <Button variant='outline' disabled={busy} onClick={() => void saveTime()}>
            保存
          </Button>
          <span className='text-subtle'>每天到点签一次（启动时当天没签会自动补）</span>
        </div>

        <div className='mt-2 flex flex-wrap items-center gap-2 text-[13px]'>
          <span className='w-[124px] shrink-0'>账号之间的间隔</span>
          <Input
            type='number'
            min={0}
            max={1440}
            className='max-w-[90px]'
            value={gapDraft}
            disabled={busy}
            onChange={event => setGapDraft(event.target.value)}
          />
          <span className='text-subtle'>分钟</span>
          <Button variant='outline' disabled={busy} onClick={() => void saveGap()}>
            保存
          </Button>
          <span className='text-subtle'>签完一个账号隔多久再签下一个（0 = 不等待）</span>
        </div>
        {note ? <p className='detail mt-1'>{note}</p> : null}
      </div>
      <CheckinHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        provider='trae'
        providerLabel='Trae'
      />
    </section>
  )
}
