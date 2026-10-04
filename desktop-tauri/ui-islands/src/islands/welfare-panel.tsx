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

declare global {
  interface Window {
    wbWelfarePanel?: { load: () => void }
  }
}

/* ─── 数据形状（与后端 / 既有弹窗逐字对齐）─────────────────── */

type Campaign = {
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
  return { text: `不可领（${item.status || '未知'}）`, tone: '' }
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

  return (
    <div className='flex flex-col gap-4'>
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
        <p className='detail'>
          「探测全部」是<strong>只读</strong>的：它只问上游「现在有哪些活动、每个账号领没领」，
          不会消耗任何领取机会，可以随手点。真正的领取是<strong>写操作</strong>，按账号单独点「领取」。
        </p>
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
          <span className='detail'>
            上次：{task?.lastResult || '未执行'}（{agoText(task?.lastSuccessAt)}）
            {task?.nextRunAt ? ` · 下次 ${agoText(task.nextRunAt).replace('前', '后')}` : ''}
          </span>
        </div>
        <p className='detail'>
          间隔只决定「多久看一次资格」；真正发写请求的次数由本地台账兜住
          （每天最多 6 次、间隔至少 10 分钟），所以调小不会把上游打多。
        </p>
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
        {accounts.length === 0 ? (
          <p className='detail'>还没有码道账号。先去「账号」页添加。</p>
        ) : (
          <div className='flex flex-col gap-3'>
            {accounts.map(account => {
              const preview = previews[account.id]
              const campaigns = preview?.campaigns || []
              const failure = errors[account.id]
              return (
                <div key={account.id} className='rounded-lg border border-border p-3'>
                  <div className='flex flex-wrap items-center gap-3'>
                    <b className='text-[13px]'>{account.name || account.id}</b>
                    {failure ? (
                      <span className='badge bad'>探测失败</span>
                    ) : (
                      <span className={`badge ${claimable(preview) > 0 ? 'warn' : 'ok'}`}>
                        {claimable(preview) > 0 ? `${claimable(preview)} 项可领` : '暂无可领'}
                      </span>
                    )}
                    {account.enabled === false ? <span className='badge'>已禁用</span> : null}
                    <span className='detail'>
                      今天（北京时间 {preview?.day || '—'}）已试 {preview?.attempts ?? 0} 次，
                      还能试 {preview?.attemptsLeft ?? 0} 次
                      {preview?.nextAttemptInMs
                        ? `，最快 ${Math.ceil(preview.nextAttemptInMs / 60000)} 分钟后可再试`
                        : ''}
                    </span>
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
                    <ul className='mt-2 flex flex-col gap-1'>
                      {campaigns.length === 0 ? (
                        <li className='detail'>没有可自动领的活动</li>
                      ) : (
                        campaigns.map((item, index) => {
                          const badge = campaignBadge(item)
                          return (
                            <li
                              key={`${account.id}-${index}`}
                              className='flex items-center gap-2 text-[13px]'
                              title={item.status || ''}
                            >
                              <b>{campaignLabel(item)}</b>
                              <span className={`badge ${badge.tone}`}>{badge.text}</span>
                              {item.name ? <span className='detail'>{item.name}</span> : null}
                            </li>
                          )
                        })
                      )}
                    </ul>
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
      </section>
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
