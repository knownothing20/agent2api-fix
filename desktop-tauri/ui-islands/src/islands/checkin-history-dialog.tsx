/**
 * Agent2API · 「签到历史」弹窗（2026-10-16 用户要求）。
 *
 * ── 解决什么 ────────────────────────────────────────────────
 * 用户问「最近几天是不是都签到不了了」时，能拿到的信息只有面板上那个
 * 「未签到」和任务卡上那句「失败 1 个」—— **看不到是谁、为什么**。
 * 数据本来就产生了（后端 `run_round` 手里有每个账号的 message），只是没留。
 * 后端现在把它落进 `core::checkin_history` 那份台账（Trae 与通用签到写同一份），
 * 这个弹窗就是它的界面：一行一次签到，失败的那行直接写着上游原话。
 *
 * ── 为什么默认只看当前渠道、又给一个「全部」开关 ──────────────
 * 入口在「福利 → Trae」标签里，用户此刻关心的是 Trae —— 默认只列 Trae 最贴近
 * 意图；但签到不止一家（账号页的 WorkBuddy 系签到写的是同一份台账），
 * 所以留一个开关能横向看全部，不用去别处找第二个入口。
 *
 * ── 字段来源 ────────────────────────────────────────────────
 * 全部来自 `GET /api/checkin-history`（后端 `checkin_history::response`）。
 * `source`（手动 / 定点 / 定时）是有意展示的：排查时第一个要问的就是
 * 「这条是我手点的，还是它自己跑的」—— 两者的失败原因往往不同。
 */
import * as React from 'react'
import {
  Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@ui'

import { describeError, shared, toast } from './add-account-bridge'

/** 一条签到记录（与后端 `checkin_history::Entry` 的落盘形状一一对应）。 */
export type CheckinRecord = {
  at: number
  provider: string
  accountId: string
  name: string
  uid: string
  /** `success` / `already` / `fail` */
  status: string
  credits: number | null
  delta: number
  message: string
  errorType: string | null
  /** `manual` / `daily` / `interval` */
  source: string
}

/** 取多少条：够翻两周，又不至于一次塞太多 DOM。 */
const FETCH_LIMIT = 200

/** 通用请求入口（与福利页、模型页同一取舍：新端点没有具名桥方法）。 */
type ProvidersBridge = {
  customRequest?: <T>(method: string, path: string, body?: unknown) => Promise<T>
}

async function fetchHistory(provider?: string): Promise<{ records: CheckinRecord[]; total: number }> {
  const providers = shared().wbProviders as unknown as ProvidersBridge | undefined
  if (!providers?.customRequest) throw new Error('目录模块未就绪')
  const query = provider ? `?provider=${encodeURIComponent(provider)}&limit=${FETCH_LIMIT}` : `?limit=${FETCH_LIMIT}`
  const data = await providers.customRequest<{ records?: CheckinRecord[]; total?: number }>(
    'GET', `/api/checkin-history${query}`,
  )
  return { records: data?.records ?? [], total: data?.total ?? 0 }
}

async function clearHistory(provider?: string): Promise<number> {
  const providers = shared().wbProviders as unknown as ProvidersBridge | undefined
  if (!providers?.customRequest) throw new Error('目录模块未就绪')
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : ''
  const data = await providers.customRequest<{ removed?: number }>(
    'DELETE', `/api/checkin-history${query}`,
  )
  return data?.removed ?? 0
}

/** `MM-DD HH:mm:ss` —— 签到是「每天一次」的事，跨天看日期比看年份重要。 */
function formatAt(at: number): string {
  if (!at) return '—'
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const STATUS_TEXT: Record<string, string> = {
  success: '成功',
  already: '今日已签',
  fail: '失败',
}

const SOURCE_TEXT: Record<string, string> = {
  manual: '手动',
  daily: '定点',
  interval: '定时',
}

function statusClass(status: string): string {
  if (status === 'success') return 'badge ok'
  if (status === 'fail') return 'badge bad'
  return 'badge'
}

export function CheckinHistoryDialog({
  open,
  onOpenChange,
  provider,
  providerLabel,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** 默认只看哪一家（`undefined` = 全部）。 */
  provider?: string
  /** 默认视角的展示名，用在开关文案上（例如「只看 Trae」）。 */
  providerLabel?: string
}): React.ReactElement {
  const [records, setRecords] = React.useState<CheckinRecord[]>([])
  const [total, setTotal] = React.useState(0)
  const [onlyCurrent, setOnlyCurrent] = React.useState(Boolean(provider))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [loaded, setLoaded] = React.useState(false)

  const load = React.useCallback(async (scoped: boolean) => {
    setBusy(true)
    setError('')
    try {
      const data = await fetchHistory(scoped ? provider : undefined)
      setRecords(data.records)
      setTotal(data.total)
      setLoaded(true)
    } catch (issue) {
      setError(describeError(issue))
    } finally {
      setBusy(false)
    }
  }, [provider])

  // 打开时（以及切换「只看当前渠道」时）拉一次；关闭后不保留上一次的 loading 态
  React.useEffect(() => {
    if (!open) return
    void load(onlyCurrent)
  }, [open, onlyCurrent, load])

  async function clearAll(): Promise<void> {
    const scope = onlyCurrent && provider ? `${providerLabel || provider} 的` : '全部渠道的'
    if (!window.confirm(`清空${scope}签到历史？这只删本地记录，不影响账号与积分。`)) return
    setBusy(true)
    try {
      const removed = await clearHistory(onlyCurrent ? provider : undefined)
      toast(`✅ 已清空 ${removed} 条签到记录`)
      await load(onlyCurrent)
    } catch (issue) {
      toast(`清空失败：${describeError(issue)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const failed = records.filter(item => item.status === 'fail').length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-[860px]'>
        <DialogHeader>
          <DialogTitle>签到历史</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className='flex flex-wrap items-center gap-3 text-[12px] text-subtle'>
            <span>
              共 {total} 条{records.length < total ? `（显示最近 ${records.length} 条）` : ''}
              {failed > 0 ? ` · 其中失败 ${failed} 条` : ''}
            </span>
            {provider ? (
              <label className='flex items-center gap-1.5 text-[12px]'>
                <input
                  type='checkbox'
                  checked={onlyCurrent}
                  onChange={event => setOnlyCurrent(event.target.checked)}
                />
                只看 {providerLabel || provider}
              </label>
            ) : null}
            <span className='ml-auto flex items-center gap-2'>
              <Button variant='outline' size='sm' disabled={busy} onClick={() => void load(onlyCurrent)}>
                刷新
              </Button>
              <Button variant='outline' size='sm' disabled={busy || records.length === 0} onClick={() => void clearAll()}>
                清空
              </Button>
            </span>
          </div>

          {error ? (
            <p className='mt-3 text-[12px]' style={{ color: 'var(--danger)' }}>
              读取失败：{error}
            </p>
          ) : null}

          {!error && loaded && records.length === 0 ? (
            <p className='detail mt-3'>
              还没有签到记录。下一次签到（手动点「签到」或等到定点时间）之后就会出现。
            </p>
          ) : null}

          {records.length > 0 ? (
            <div className='mt-3 max-h-[52vh] overflow-auto'>
              <table className='w-full text-[12.5px]'>
                <thead className='sticky top-0'>
                  <tr className='text-left text-subtle'>
                    <th className='py-1.5 pr-3 font-medium'>时间</th>
                    <th className='py-1.5 pr-3 font-medium'>账号</th>
                    {onlyCurrent && provider ? null : <th className='py-1.5 pr-3 font-medium'>渠道</th>}
                    <th className='py-1.5 pr-3 font-medium'>来源</th>
                    <th className='py-1.5 pr-3 font-medium'>结果</th>
                    <th className='py-1.5 pr-3 font-medium'>积分</th>
                    <th className='py-1.5 font-medium'>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((item, index) => (
                    <tr key={`${item.at}-${item.accountId}-${index}`} className='border-t border-border align-top'>
                      <td className='whitespace-nowrap py-1.5 pr-3 font-mono text-subtle'>{formatAt(item.at)}</td>
                      <td className='py-1.5 pr-3'>
                        {item.name || item.accountId || '—'}
                        {item.uid ? <span className='ml-1 text-subtle'>({item.uid})</span> : null}
                      </td>
                      {onlyCurrent && provider ? null : (
                        <td className='py-1.5 pr-3 text-subtle'>{item.provider || '—'}</td>
                      )}
                      <td className='py-1.5 pr-3 text-subtle'>{SOURCE_TEXT[item.source] || item.source || '—'}</td>
                      <td className='py-1.5 pr-3'>
                        <span className={statusClass(item.status)}>
                          {STATUS_TEXT[item.status] || item.status}
                        </span>
                      </td>
                      <td className='whitespace-nowrap py-1.5 pr-3 font-mono'>
                        {item.credits === null || item.credits === undefined ? '—' : item.credits}
                        {item.delta > 0 ? <span className='text-subtle'>（+{item.delta}）</span> : null}
                      </td>
                      <td className='py-1.5'>
                        {item.message || '—'}
                        {item.errorType ? <span className='ml-1 text-subtle'>[{item.errorType}]</span> : null}
                      </td>
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
