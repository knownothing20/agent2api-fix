/**
 * Agent2API · 「积分到期」总览弹窗（2026-10-16 用户要求，参照 workbuddy2api 的同名页面）。
 *
 * ── 解决什么 ────────────────────────────────────────────────
 * 「积分明细」回答的是**一个账号**的问题（点某一行才看得到）；这一屏回答的是
 * **全部账号**的问题：谁快作废、作废多少、最近什么时候到期。
 * 积分过期即作废，而真实账号的余额常是「一个月度大包 + 若干个每天发的小包」——
 * 只看总数会把「今天有 100 分要没了」完全藏起来。
 *
 * ── 与参考面板的一处有意不同 ─────────────────────────────────
 * 它那一页写「在临期窗口内 —— 调度会优先消耗」，因为它有 `expiring_first` 调度；
 * **agent2api 没有这个调度**（选路读的是整期重置日 + 剩余量，与逐包到期无关）。
 * 所以这里只说「这些分什么时候没」，**不承诺调度行为** —— 编一个不存在的承诺
 * 比不显示更糟。这一点后端模块头里也写了。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────
 * `GET /api/credits/expiry`，默认读**已有的余额快照**（打开这一页零上游成本），
 * 点「刷新」才带 `?refresh=1` 真查一遍。所以页面上必须显示快照时刻 ——
 * 否则用户会以为「临期 0」是刚刚算出来的。
 */
import * as React from 'react'
import {
  Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@ui'

import { describeError, shared, toast } from './add-account-bridge'

type PackageRow = {
  name?: string
  packageCode?: string
  left?: number
  total?: number
  used?: number
  /** 毫秒（0/缺失 → null） */
  expireAt?: number | null
  isDaily?: boolean
  /** 在临期窗口内（后端按自然日算好的结论，前端不重算） */
  expiring?: boolean
}

type ExpiryRow = {
  id: string
  name: string
  provider: string
  disabled: boolean
  left?: number
  expiring?: number
  packageCount?: number
  nearestAt?: number | null
  packages?: PackageRow[]
  /** 上游不给逐包到期（后端给的机器可读标记，不是文案） */
  unsupported?: boolean
  /** **真正的异常**才用它（余额查询失败 / 还没查过）；「上游不提供」不进这里 */
  note?: string
}

type ExpiryView = {
  at: number
  horizonDays: number
  deadlineAt: number
  deadlineText: string
  totals: {
    accounts: number
    disabled: number
    supported: number
    unsupported: number
    failed: number
    totalLeft: number
    expiring: number
    disabledLeft: number
  }
  rows: ExpiryRow[]
}

async function fetchExpiry(refresh: boolean): Promise<ExpiryView> {
  const providers = shared().wbProviders as unknown as {
    customRequest?: <T>(method: string, path: string, body?: unknown) => Promise<T>
  } | undefined
  if (!providers?.customRequest) throw new Error('目录模块未就绪')
  return providers.customRequest<ExpiryView>(
    'GET', `/api/credits/expiry${refresh ? '?refresh=1' : ''}`,
  )
}

const numberText = (value: unknown): string => {
  const num = Number(value)
  return Number.isFinite(num) ? num.toLocaleString('zh-CN') : '—'
}

/** 毫秒 → `MM-DD HH:mm`（跨年才带年，这一屏看的是最近几天）。 */
function shortTime(at?: number | null): string {
  if (!at) return '—'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 倒计时（以本机时钟为准，与明细弹窗同一口径）。 */
function countdown(at?: number | null): { text: string; urgent: boolean } {
  if (!at) return { text: '无期限', urgent: false }
  const ms = at - Date.now()
  if (ms <= 0) return { text: '已过期', urgent: true }
  const hours = ms / 3_600_000
  const days = Math.floor(hours / 24)
  if (days >= 1) return { text: `${days} 天 ${Math.floor(hours % 24)} 小时后`, urgent: false }
  if (hours >= 1) return { text: `${Math.floor(hours)} 小时后`, urgent: true }
  return { text: `${Math.max(1, Math.floor(ms / 60_000))} 分钟后`, urgent: true }
}

export function CreditsExpiryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
}): React.ReactElement {
  const [view, setView] = React.useState<ExpiryView | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())

  const load = React.useCallback(async (refresh: boolean) => {
    setBusy(true)
    setError('')
    try {
      setView(await fetchExpiry(refresh))
    } catch (issue) {
      setError(describeError(issue))
    } finally {
      setBusy(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    // 打开时**不刷新**（零上游成本）：想看最新值点「刷新」
    void load(false)
  }, [open, load])

  const totals = view?.totals
  const rows = view?.rows ?? []
  // 有没有**任何一家**提供逐包到期（用户要求：有就加，没有就不加）。
  // 全都没有时（本面板就是：4 个码道 + 2 个 Trae，上游都不给），
  // 画「临期 / 最近到期 / 包数」三列 = 三列全是「—」+ 每行一句长说明，
  // 占掉半屏却没有任何信息 ⇒ 那三列不画，说明收到页脚一句。
  const anySupported = rows.some(row => (row.packageCount ?? 0) > 0)

  function toggle(id: string): void {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-[1000px]'>
        <DialogHeader>
          <DialogTitle>积分到期</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-subtle'>
            {totals ? (
              <span>
                {totals.accounts} 个账号
                {totals.disabled > 0 ? `（含 ${totals.disabled} 个已禁用）` : ''}
                {' · '}可用余额 <b>{numberText(totals.totalLeft)}</b> 分
                {anySupported && totals.expiring > 0 ? (
                  <> · 临期 <b style={{ color: 'var(--warn)' }}>{numberText(totals.expiring)}</b> 分</>
                ) : null}
                {totals.disabledLeft > 0 ? ` · 禁用号另有 ${numberText(totals.disabledLeft)} 分（未计入）` : ''}
                {anySupported ? ` · 窗口 ${view?.horizonDays} 天` : ''}
              </span>
            ) : null}
            <span className='ml-auto flex items-center gap-2'>
              <span>
                {view?.at ? `余额查询于 ${shortTime(view.at)}` : '还没查过余额'}
              </span>
              <Button variant='outline' size='sm' disabled={busy} onClick={() => void load(false)}>
                只读刷新
              </Button>
              <Button variant='outline' size='sm' disabled={busy} onClick={() => {
                toast('正在查询全部账号的余额…')
                void load(true)
              }}>
                {busy ? '查询中…' : '刷新余额'}
              </Button>
            </span>
          </div>

          {/* 没有一家提供逐包到期时，「临期窗口」这句话就是空谈 ⇒ 不出现 */}
          <p className='detail mt-2'>
            {anySupported ? (
              <>
                临期窗口按<strong>自然日</strong>算：截止到 {view?.deadlineText || '—'} 之前到期的部分。
              </>
            ) : null}
            「刷新余额」会真的去打一次上游（等价于点账号页的「查询余额」），平时打开这一页只读本地快照。
          </p>

          {/* 一行都没有逐包数据时（本面板就是），说明只出现这一句 —— 不再逐行重复 */}
          {!anySupported && rows.length > 0 ? (
            <p className='detail mt-3'>
              当前这些账号的<strong>上游都不提供逐包到期时间</strong>（码道与 Trae 只给整期重置日），
              所以这里只列余额，不显示「临期 / 最近到期 / 包数」。
            </p>
          ) : null}

          {error ? (
            <p className='mt-3 text-[12px]' style={{ color: 'var(--danger)' }}>读取失败：{error}</p>
          ) : null}

          {!error && rows.length === 0 ? (
            <p className='detail mt-3'>还没有账号，或还没查询过余额。</p>
          ) : null}

          {rows.length > 0 ? (
            <div className='mt-3 max-h-[58vh] overflow-auto'>
              <table className='w-full text-[12.5px]'>
                <thead className='sticky top-0'>
                  <tr className='text-left text-subtle'>
                    <th className='py-1.5 pr-3 font-medium'>账号</th>
                    <th className='py-1.5 pr-3 font-medium'>渠道</th>
                    <th className='py-1.5 pr-3 text-right font-medium'>总余额</th>
                    {anySupported ? <th className='py-1.5 pr-3 text-right font-medium'>临期</th> : null}
                    {anySupported ? <th className='py-1.5 pr-3 font-medium'>最近到期</th> : null}
                    {anySupported ? <th className='py-1.5 pr-3 text-right font-medium'>包数</th> : null}
                    {/* 「说明」列只在有内容时画：没有逐包数据、又没有失败行时，
                        它是一列全空 —— 那就不该占一列 */}
                    {anySupported || rows.some(row => row.note) ? (
                      <th className='py-1.5 font-medium'>说明</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const canExpand = (row.packages?.length ?? 0) > 0
                    const isOpen = expanded.has(row.id)
                    return (
                      <React.Fragment key={row.id}>
                        <tr
                          className={`border-t border-border ${row.disabled ? 'opacity-60' : ''} ${canExpand ? 'cursor-pointer' : ''}`}
                          onClick={() => { if (canExpand) toggle(row.id) }}
                        >
                          <td className='py-1.5 pr-3'>
                            {canExpand ? <span className='mr-1 text-subtle'>{isOpen ? '▾' : '▸'}</span> : <span className='mr-1'>·</span>}
                            {row.name}
                            {row.disabled ? <span className='ml-1 text-subtle'>已禁用</span> : null}
                          </td>
                          <td className='py-1.5 pr-3 text-subtle'>{row.provider || '—'}</td>
                          <td className='py-1.5 pr-3 text-right font-mono'>
                            {row.left === undefined || row.left === null ? '—' : numberText(row.left)}
                          </td>
                          {anySupported ? (
                            <td className='py-1.5 pr-3 text-right font-mono'>
                              {row.expiring ? (
                                <span style={{ color: 'var(--warn)' }}>{numberText(row.expiring)}</span>
                              ) : '0'}
                            </td>
                          ) : null}
                          {anySupported ? <td className='py-1.5 pr-3 text-subtle'>{shortTime(row.nearestAt)}</td> : null}
                          {anySupported ? <td className='py-1.5 pr-3 text-right font-mono'>{row.packageCount ?? '—'}</td> : null}
                          {anySupported || rows.some(item => item.note) ? (
                            <td className='py-1.5 text-subtle'>{row.note || (row.unsupported ? '' : '')}</td>
                          ) : null}
                        </tr>
                        {canExpand && isOpen ? (
                          <tr className='border-t border-border'>
                            <td colSpan={anySupported ? 7 : (rows.some(row => row.note) ? 3 : 2)} className='py-2'>
                              <div className='flex flex-wrap gap-2'>
                                {(row.packages ?? []).map((item, index) => {
                                  const cd = countdown(item.expireAt)
                                  return (
                                    <div
                                      key={`${row.id}-pkg-${index}`}
                                      className='min-w-[168px] rounded-lg border p-2 text-[11.5px]'
                                      style={{
                                        borderColor: item.expiring ? 'var(--warn)' : 'var(--border)',
                                        background: item.expiring ? 'var(--warn-soft)' : 'transparent',
                                      }}
                                    >
                                      <div className='flex items-center gap-1'>
                                        <b>{item.name || item.packageCode || '包'}</b>
                                        {item.expiring ? <span className='badge warn'>临期</span> : null}
                                      </div>
                                      <div className='mt-0.5 text-subtle'>
                                        到期 {shortTime(item.expireAt)}
                                      </div>
                                      <div className='mt-1 font-mono'>
                                        {numberText(item.left)} 分
                                        {item.total ? <span className='text-subtle'> / {numberText(item.total)}</span> : null}
                                        {item.isDaily ? <span className='ml-1 text-subtle'>每日</span> : null}
                                      </div>
                                      <div className={cd.urgent ? '' : 'text-subtle'} style={cd.urgent ? { color: 'var(--warn)' } : undefined}>
                                        {cd.text}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
