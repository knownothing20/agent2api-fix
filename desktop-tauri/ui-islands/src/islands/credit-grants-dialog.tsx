/**
 * Agent2API · 「领取历史 / 积分明细」弹窗（2026-10-16 用户要求）。
 *
 * ── 两个入口，同一份数据 ────────────────────────────────────
 *   · 福利页「码道」标签 → 「领取历史」（看这一家的领取流水，不筛账号）
 *   · 账号页「积分预览」→ 标题右边的「积分明细」（只看这一个账号）
 * 用户先要的是「每一次积分的领取时间、到期时间」，随后又要「码道加个领取历史」——
 * 两句话要的是同一份流水，所以只做一个弹窗、开两个口。
 *
 * ── ★ 必须说清的两件事（都写在界面里，不靠用户猜）──────────────
 *   1. **这份台账是我们自己记的**：上游根本不提供流水接口（CodeArts 的 8 条路径里
 *      没有任何「明细 / 流水」，福利台账是按天存的、没有历史）⇒ 只能从**上线那天**
 *      起累积，历史补不回来。
 *   2. **「到期」那一列是整期**（CodeArts 的 `resetDate` / Trae 的 `expireAt`）——
 *      上游不提供逐笔到期。有逐包到期的家（WorkBuddy）走的是另一条路（余额里的
 *      `packages`，见「积分到期」页）。所以列名写成「本期到」，并在脚注里讲明白。
 */
import * as React from 'react'
import {
  Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@ui'

import { describeError, shared, toast } from './add-account-bridge'

type GrantRecord = {
  at: number
  provider: string
  accountId: string
  /** `welfare`（福利领取）/ `checkin`（签到） */
  source: string
  name: string
  amount: number | null
  unit: string
  note: string
}

type Period = { at: number; text: string; kind: 'reset' | 'expire' }

async function fetchGrants(
  provider?: string,
  accountId?: string,
): Promise<{ records: GrantRecord[]; total: number; periods: Record<string, Period> }> {
  const bridge = shared().wbProviders as unknown as {
    customRequest?: <T>(method: string, path: string, body?: unknown) => Promise<T>
  } | undefined
  if (!bridge?.customRequest) throw new Error('目录模块未就绪')
  const params = new URLSearchParams()
  if (provider) params.set('provider', provider)
  if (accountId) params.set('accountId', accountId)
  params.set('limit', '300')
  const data = await bridge.customRequest<{
    records?: GrantRecord[]
    total?: number
    periods?: Record<string, Period>
  }>('GET', `/api/credit-grants?${params.toString()}`)
  return {
    records: data?.records ?? [],
    total: data?.total ?? 0,
    periods: data?.periods ?? {},
  }
}

async function clearGrants(provider?: string, accountId?: string): Promise<number> {
  const bridge = shared().wbProviders as unknown as {
    customRequest?: <T>(method: string, path: string, body?: unknown) => Promise<T>
  } | undefined
  if (!bridge?.customRequest) throw new Error('目录模块未就绪')
  const params = new URLSearchParams()
  if (provider) params.set('provider', provider)
  if (accountId) params.set('accountId', accountId)
  const data = await bridge.customRequest<{ removed?: number }>(
    'DELETE', `/api/credit-grants?${params.toString()}`,
  )
  return data?.removed ?? 0
}

/** `MM-DD HH:mm:ss` —— 领取是「每天一次」的事，跨天看日期比看年份重要。 */
function stamp(at: number): string {
  if (!at) return '—'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const SOURCE_TEXT: Record<string, string> = {
  welfare: '福利领取',
  checkin: '签到',
}

const numberText = (value: unknown): string => {
  const num = Number(value)
  return Number.isFinite(num) ? num.toLocaleString('zh-CN') : '—'
}

export function CreditGrantsDialog({
  open,
  onOpenChange,
  provider,
  accountId,
  title,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** 只看某一家的流水（福利页码道 tab 传 `codearts`）。 */
  provider?: string
  /** 只看某一个账号（账号页余额弹窗传账号 id）。 */
  accountId?: string
  /** 标题（两个入口各用各的：「领取历史」/「积分明细」）。 */
  title?: string
}): React.ReactElement {
  const [records, setRecords] = React.useState<GrantRecord[]>([])
  const [periods, setPeriods] = React.useState<Record<string, Period>>({})
  const [total, setTotal] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [loaded, setLoaded] = React.useState(false)

  const load = React.useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const data = await fetchGrants(provider, accountId)
      setRecords(data.records)
      setPeriods(data.periods)
      setTotal(data.total)
      setLoaded(true)
    } catch (issue) {
      setError(describeError(issue))
    } finally {
      setBusy(false)
    }
  }, [provider, accountId])

  React.useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  async function clearAll(): Promise<void> {
    if (!window.confirm('清空这份发放台账？只删本地记录，不影响账号与积分。')) return
    setBusy(true)
    try {
      const removed = await clearGrants(provider, accountId)
      toast(`✅ 已清空 ${removed} 条发放记录`)
      await load()
    } catch (issue) {
      toast(`清空失败：${describeError(issue)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  /** 「本期到」那一列：整期到期日（真实值），拿不到就说清楚。 */
  function periodText(id: string): string {
    const period = periods[id]
    if (!period) return '上游未提供'
    if (period.kind === 'reset' && period.text) return `本期到 ${period.text}`
    return `本期到 ${stamp(period.at).slice(0, 5)}`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-[880px]'>
        <DialogHeader>
          <DialogTitle>{title || '领取历史'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className='flex flex-wrap items-center gap-3 text-[12px] text-subtle'>
            <span>
              共 {total} 条{records.length < total ? `（显示最近 ${records.length} 条）` : ''}
            </span>
            <span className='ml-auto flex items-center gap-2'>
              <Button variant='outline' size='sm' disabled={busy} onClick={() => void load()}>
                刷新
              </Button>
              <Button variant='outline' size='sm' disabled={busy || records.length === 0} onClick={() => void clearAll()}>
                清空
              </Button>
            </span>
          </div>

          {/* 两条如实说明：数据是我们记的 + 到期那一列是整期 */}
          <p className='detail mt-2'>
            这份台账<strong>由本地面板记录</strong> —— 上游不提供「领取流水」接口，
            所以只能从<strong>本功能上线那天</strong>起累积，更早的历史补不回来。
            「到期」那一列给的是<strong>整期到期日</strong>（该账号当前周期的结束日）；
            上游不提供「逐笔积分什么时候作废」，有逐包到期的家请看「积分到期」页。
          </p>

          {error ? (
            <p className='mt-3 text-[12px]' style={{ color: 'var(--danger)' }}>读取失败：{error}</p>
          ) : null}

          {!error && loaded && records.length === 0 ? (
            <p className='detail mt-3'>
              还没有发放记录。等下一次签到成功、或码道福利领取到账之后就会出现。
            </p>
          ) : null}

          {records.length > 0 ? (
            <div className='mt-3 max-h-[54vh] overflow-auto'>
              <table className='w-full text-[12.5px]'>
                <thead className='sticky top-0'>
                  <tr className='text-left text-subtle'>
                    <th className='py-1.5 pr-3 font-medium'>领取时间</th>
                    <th className='py-1.5 pr-3 font-medium'>账号</th>
                    <th className='py-1.5 pr-3 font-medium'>来源</th>
                    <th className='py-1.5 pr-3 font-medium'>名称</th>
                    <th className='py-1.5 pr-3 text-right font-medium'>数量</th>
                    <th className='py-1.5 font-medium'>到期</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((item, index) => (
                    <tr key={`${item.at}-${item.accountId}-${index}`} className='border-t border-border align-top'>
                      <td className='whitespace-nowrap py-1.5 pr-3 font-mono text-subtle'>{stamp(item.at)}</td>
                      <td className='py-1.5 pr-3'>{item.accountId || '—'}</td>
                      <td className='py-1.5 pr-3 text-subtle'>{SOURCE_TEXT[item.source] || item.source || '—'}</td>
                      <td className='py-1.5 pr-3'>
                        {item.name || '—'}
                        {item.note ? <span className='ml-1 text-subtle'>（{item.note}）</span> : null}
                      </td>
                      <td className='whitespace-nowrap py-1.5 pr-3 text-right font-mono'>
                        {item.amount === null || item.amount === undefined
                          ? '—'
                          : `${numberText(item.amount)} ${item.unit || ''}`.trim()}
                      </td>
                      <td className='whitespace-nowrap py-1.5 text-subtle'>{periodText(item.accountId)}</td>
                    </tr>
                  ))}
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
