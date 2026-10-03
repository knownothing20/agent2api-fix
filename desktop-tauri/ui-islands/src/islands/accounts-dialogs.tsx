/**
 * 账号的两个弹窗：**账号设置**与**批量操作**（替换 ui/account-panel.js + ui/proxy-form.js）。
 *
 * 对外契约：`window.wbAccountPanel = { open, close, openBatch, closeBatch, syncAddProvider,
 * invalidate }`（app.js:623 调 invalidate、app.js:645 调 open）—— 注册在 accounts-data.ts，
 * 这里只提供界面。
 *
 * ── 代理表单为什么也在这里 ────────────────────────────────────
 * 它原先是一个可复用的命令式组件（ui/proxy-form.js：自己 innerHTML 建标记、多实例各用
 * 一套 id 命名空间），两个弹窗共用。迁到 React 之后「多实例 id 串台」这个问题天然消失
 * （每个实例的 DOM 归 React 管），表单状态直接提在弹窗的 state 里，`readProxy` 是一个
 * 纯函数 —— 于是不再需要「组件实例 + create/fill/read」那层协议。
 *
 * ── 优先级唯一约束的作用域是**同 provider 内** ─────────────────
 * 后端 `store_crud` 的 `provider_peers` 只在同一家内校验唯一与号段，于是
 * 「workbuddy 有 P100」与「小浣熊有 P100」合法并存。占用提示必须按同一口径过滤：
 * 跨家比较会把一个完全可以保存的数值报成「已被占用」，用户只能改用大号段。
 */

import * as React from 'react'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@ui'
import {
  errorMessage, esc, poolItemLabel, shared, toast,
  type AccountRecord, type ClashSnapshot, type PoolItem,
} from './accounts-shared'
import { clampPriority, priorityOf, PRIORITY_MAX, PRIORITY_MIN } from './accounts-columns'
import {
  providerOf, supportsPlanChannel, zcodePlanLabel, zcodePlanOf,
  ZCODE_PLAN_CODING, ZCODE_PLAN_START,
} from './accounts-domain'
import {
  allAccounts, clashOptions, closeDialog, findAccount, getStore, proxyPoolOptions,
} from './accounts-data'

/** 名称长度上限，与后端 custom_providers::MAX_NAME_CHARS 一致（前端先挡一次） */
const MAX_PROVIDER_NAME_CHARS = 64

type AccountLike = AccountRecord

/** 同 provider 的其它账号：优先级唯一性的作用域就是这一组 */
function peersOf(account: AccountLike, all: AccountLike[]): AccountLike[] {
  const provider = providerOf(account)
  return all.filter(item => item.id !== account.id && providerOf(item) === provider)
}

function labelOf(account: AccountLike | null | undefined): string {
  return account?.nickname || account?.name || account?.id || ''
}

/* ─── 代理表单 ──────────────────────────────── */

export type ProxyPayload =
  | null
  | { source: 'pool'; proxyId: string }
  | { source: 'clash'; listenerUid: string }
  | { source: 'custom'; protocol: 'http' | 'socks5'; host: string; port: number; username: string; password: string }

export type ProxyDraft = {
  mode: 'none' | 'pool' | 'clash' | 'custom'
  /** 池条目 id（mode === 'pool'） */
  proxyId: string
  listenerUid: string
  protocol: 'http' | 'socks5'
  host: string
  port: string
  username: string
  password: string
}

/** 账号 proxy 字段 → 表单草稿（形态与后端 workbuddy-proxy.mjs 一致） */
export function draftOfProxy(proxy: AccountRecord['proxy']): ProxyDraft {
  const source = proxy?.config?.source || proxy?.source
  const config = proxy?.config || null
  return {
    mode: source === 'pool' ? 'pool' : source === 'clash' ? 'clash' : source === 'custom' ? 'custom' : 'none',
    proxyId: source === 'pool' ? String(config?.proxyId || '') : '',
    listenerUid: config?.source === 'clash' || source === 'clash' ? String(config?.listenerUid || '') : '',
    protocol: config?.protocol === 'socks5' ? 'socks5' : 'http',
    host: config?.host || '',
    port: config?.port === undefined || config?.port === null ? '' : String(config.port),
    username: config?.username || '',
    password: config?.password || '',
  }
}

/** 草稿 → 接口 payload；非法输入抛出「面向用户」的错误（消息直接进 toast / 弹窗状态行） */
export function readProxyDraft(draft: ProxyDraft): ProxyPayload {
  if (draft.mode === 'none') return null
  if (draft.mode === 'pool') {
    if (!draft.proxyId) throw new Error('请先选择已保存的代理')
    return { source: 'pool', proxyId: draft.proxyId }
  }
  if (draft.mode === 'clash') {
    if (!draft.listenerUid) throw new Error('请先选择 Clash Verge 出口')
    return { source: 'clash', listenerUid: draft.listenerUid }
  }
  const host = draft.host.trim()
  const port = Number(draft.port)
  if (!host) throw new Error('请填写代理主机地址')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须是 1-65535 的整数')
  return {
    source: 'custom',
    protocol: draft.protocol === 'socks5' ? 'socks5' : 'http',
    host,
    port,
    username: draft.username.trim(),
    password: draft.password,
  }
}

function clashOptionLabel(option: NonNullable<ClashSnapshot['options']>[number]): string {
  const inactive = option.profileActive === false ? '（其他订阅，可能未生效）' : ''
  const disabled = option.enabled === false ? '（已在 Clash 中禁用）' : ''
  return `${option.name} :${option.port}${inactive}${disabled}`
}

/**
 * 出网代理表单（账号设置与批量改代理共用）。刻意**不带** `data-island-input`：
 * 那是输入框岛（就地升级）的钩子，两个岛同时挂一个输入框会打架。
 *
 * 档位：
 *   · 无代理（直连）/ 自定义 —— 与改造前一致；
 *   · **已保存的代理** —— 引用「网络代理」页的池条目（推荐路径：出口在那里
 *     配一次、测一次，所有引用它的账号一起生效）。选项文案是
 *     「名字（协议 主机:端口）」，与账号页代理列同一格式（见 poolItemLabel）；
 *   · **Clash Verge** —— **只在账号当前就是直接引用 Clash 出口时出现**：
 *     那种存量记录要能改（切到别的档就消失，因为出口统一走池之后不再提供
 *     「新建一条 Clash 直引」的入口；想引用 Clash 出口请先到「网络代理」页
 *     点「同步 Clash Verge」，再从上面那一档选）。
 */
export function ProxyForm({
  draft,
  onChange,
  idPrefix,
}: {
  draft: ProxyDraft
  onChange: (next: ProxyDraft) => void
  idPrefix: string
}) {
  const store = getStore()
  const clash = store.clash
  const options = Array.isArray(clash?.options) ? clash.options : []
  /** Clash 直引档的可见性：见函数说明（存量记录专用） */
  const showClashMode = draft.mode === 'clash'
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<React.ReactNode>(null)
  /** 池列表：「已保存的代理」那一档的选项（模块级缓存，见 accounts-data） */
  const [pool, setPool] = React.useState<PoolItem[] | null>(null)
  const [poolError, setPoolError] = React.useState('')
  const set = (patch: Partial<ProxyDraft>): void => onChange({ ...draft, ...patch })

  // 出口列表只在 Clash 直引档出现时才需要（存量记录的下拉）—— 别的档不为它
  // 打这次请求
  React.useEffect(() => {
    if (showClashMode) void clashOptions().catch(() => { /* 画成「不可用」那一支 */ })
  }, [showClashMode])

  /** 读一次代理池（表单里两个入口：首次挂载与「重新读取」） */
  const loadPool = React.useCallback((force = false): void => {
    setPoolError('')
    void proxyPoolOptions({ force })
      .then(items => setPool(items))
      .catch(error => {
        setPool([])
        setPoolError(errorMessage(error))
      })
  }, [])
  // 只有选中（或初始就是）池引用时才真正去读 —— 其余三档的用户不必为一次多余的
  // 请求买单；读完缓存住，切到这一档不会再打网络
  React.useEffect(() => { if (draft.mode === 'pool' && pool === null) loadPool() }, [draft.mode, pool, loadPool])

  /** 用当前表单内容测试出口连通性 */
  async function test(): Promise<void> {
    if (testing) return
    // 池引用：测的是**那条已保存的条目**（testProxyPoolItem 会把结果记进它的
    // 「上次测试」，与代理页那一颗按钮同一个动作）—— 未选条目时给出提示
    if (draft.mode === 'pool') {
      if (!draft.proxyId) {
        toast('请先选择已保存的代理', 'err')
        return
      }
      setTesting(true)
      setTestResult('正在连接上游…')
      try {
        const data = await shared().workbuddyDesktop?.testProxyPoolItem?.(draft.proxyId)
        setTestResult(data?.success
          ? (
              <span className='text-success'>
                ✅ 出口可用
                {data.ip ? `　出口 IP ${esc(data.ip)}` : ''}
                {data.durationMs !== undefined && data.durationMs !== '' ? `　${esc(String(data.durationMs))}ms` : ''}
              </span>
            )
          : <span className='text-destructive'>❌ {esc(data?.error || '连接失败')}</span>)
      } catch (error) {
        setTestResult(<span className='text-destructive'>❌ {esc(errorMessage(error))}</span>)
      } finally {
        setTesting(false)
      }
      return
    }
    let proxy: ProxyPayload
    try {
      proxy = readProxyDraft(draft)
    } catch (error) {
      toast(errorMessage(error), 'err')
      return
    }
    setTesting(true)
    setTestResult('正在连接上游…')
    try {
      const data = await shared().workbuddyDesktop?.testProxy?.({ proxy })
      if (data?.success) {
        setTestResult(
          <span className='text-success'>
            ✅ 出口可用
            {data.status !== undefined && data.status !== '' ? `　HTTP ${esc(String(data.status))}` : ''}
            {data.ip ? `　出口 IP ${esc(data.ip)}` : ''}
            {data.durationMs !== undefined && data.durationMs !== '' ? `　${esc(String(data.durationMs))}ms` : ''}
          </span>,
        )
      } else {
        setTestResult(<span className='text-destructive'>❌ {esc(data?.error || '连接失败')}</span>)
      }
    } catch (error) {
      setTestResult(<span className='text-destructive'>❌ {esc(errorMessage(error))}</span>)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className='flex flex-col'>
      <RadioGroup value={draft.mode} onValueChange={value => set({ mode: value as ProxyDraft['mode'] })}
        className='flex-row flex-wrap items-center gap-5' aria-label='代理方式'>
        <Label className='inline-flex cursor-pointer items-center gap-2 font-normal'>
          <RadioGroupItem value='none' />无代理（直连）
        </Label>
        <Label className='inline-flex cursor-pointer items-center gap-2 font-normal'>
          <RadioGroupItem value='pool' />已保存的代理
        </Label>
        {/* Clash 直引档只对**已经是这种配置**的账号出现（见函数说明）：
            出口统一走代理池之后不再提供新建入口 */}
        {showClashMode ? (
          <Label className='inline-flex cursor-pointer items-center gap-2 font-normal'>
            <RadioGroupItem value='clash' />Clash Verge
          </Label>
        ) : null}
        <Label className='inline-flex cursor-pointer items-center gap-2 font-normal'>
          <RadioGroupItem value='custom' />自定义
        </Label>
      </RadioGroup>

      {draft.mode === 'pool' ? (
        <div className='mt-3'>
          <div className='field-row'>
            <label htmlFor={`${idPrefix}-pool-exit`}>代理</label>
            {/* value 恒为字符串（空串 = 还没选）：受控值从 undefined 切到字符串会被 Base UI
                当成「非受控 → 受控」的切换，所以不给 undefined */}
            <Select value={draft.proxyId} disabled={!pool?.length}
              onValueChange={value => set({ proxyId: String(value) })}>
              <SelectTrigger id={`${idPrefix}-pool-exit`} className='min-w-[220px]'>
                <SelectValue>
                  {pool?.find(item => item.id === draft.proxyId)
                    ? poolItemLabel(pool.find(item => item.id === draft.proxyId)!)
                    : (pool === null ? '正在读取…' : pool.length ? '请选择代理' : '还没有保存的代理')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(pool ?? []).map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {poolItemLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant='outline' size='sm' onClick={() => loadPool(true)}>重新读取</Button>
          </div>
          <div className='detail mt-1.5'>
            {poolError
              ? `读取失败：${poolError}`
              : pool === null
                ? '正在读取代理列表…'
                : pool.length
                  ? '地址与端口由「网络代理」页管理：那边改一次、测一次，所有引用它的账号一起生效'
                  : '「网络代理」页还没有出口 —— 去那里新增，或点「同步 Clash Verge」把 Clash 的出口导进来'}
          </div>
        </div>
      ) : null}

      {draft.mode === 'clash' ? (
        <div className='mt-3'>
          <div className='field-row'>
            <label htmlFor={`${idPrefix}-clash-exit`}>出口</label>
            {/* value 恒为字符串（空串 = 还没选）：受控值从 undefined 切到字符串会被 Base UI
                当成「非受控 → 受控」的切换，所以不给 undefined */}
            <Select value={draft.listenerUid} disabled={!options.length}
              onValueChange={value => set({ listenerUid: String(value) })}>
              <SelectTrigger id={`${idPrefix}-clash-exit`} className='min-w-[220px]'>
                <SelectValue>
                  {options.find(option => String(option.uid) === draft.listenerUid)
                    ? clashOptionLabel(options.find(option => String(option.uid) === draft.listenerUid)!)
                    : (clash?.available === false ? '未检测到 Clash Verge' : options.length ? '请选择出口' : '没有可用出口')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {options.map(option => (
                  <SelectItem key={String(option.uid)} value={String(option.uid)}>
                    {clashOptionLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant='outline' size='sm' onClick={() => {
              void clashOptions({ force: true })
                .then(() => toast('✅ 已重新读取 Clash Verge 配置'))
                .catch(error => toast(`读取失败：${errorMessage(error)}`, 'err'))
            }}>重新读取</Button>
          </div>
          <div className='detail mt-1.5'>
            {clash === null
              ? '正在读取 Clash Verge 配置…'
              : clash.available === false
                ? (clash.error ? `不可用：${clash.error}` : '未检测到 Clash Verge 配置')
                : options.length
                  ? `读取自 ${clash.dir || 'Clash Verge'}；端口由 Clash Verge 管理，这里实时同步`
                  : 'Clash Verge 里还没有配置混合监听器或节点端口'}
          </div>
          <p className='detail mt-1.5'>
            这是既有配置（直接引用 Clash 出口，不经过代理池）。推荐改用上面的
            <b>「已保存的代理」</b>：到「网络代理」页点「同步 Clash Verge」把出口
            导进池后即可选 —— 那样能集中测试、也能被多个账号共用。
          </p>
        </div>
      ) : null}

      {draft.mode === 'custom' ? (
        <div className='mt-3'>
          <div className='field-row'>
            <label htmlFor={`${idPrefix}-protocol`}>协议</label>
            <Select value={draft.protocol} onValueChange={value => set({ protocol: value as 'http' | 'socks5' })}>
              <SelectTrigger id={`${idPrefix}-protocol`} className='min-w-[110px]'>
                <SelectValue>{draft.protocol === 'socks5' ? 'SOCKS5' : 'HTTP'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='http'>HTTP</SelectItem>
                <SelectItem value='socks5'>SOCKS5</SelectItem>
              </SelectContent>
            </Select>
            <label htmlFor={`${idPrefix}-host`} className='ml-2'>主机</label>
            <Input id={`${idPrefix}-host`} className='min-w-[140px]' placeholder='127.0.0.1'
              value={draft.host} onChange={event => set({ host: event.currentTarget.value })} />
            <label htmlFor={`${idPrefix}-port`}>端口</label>
            <Input id={`${idPrefix}-port`} type='number' min={1} max={65535} className='max-w-[110px]'
              placeholder='7890' value={draft.port} onChange={event => set({ port: event.currentTarget.value })} />
          </div>
          <div className='field-row mt-2.5'>
            <label htmlFor={`${idPrefix}-user`}>用户名</label>
            <Input id={`${idPrefix}-user`} placeholder='可选' autoComplete='off'
              value={draft.username} onChange={event => set({ username: event.currentTarget.value })} />
            <label htmlFor={`${idPrefix}-pass`}>密码</label>
            <Input id={`${idPrefix}-pass`} type='password' placeholder='可选' autoComplete='new-password'
              value={draft.password} onChange={event => set({ password: event.currentTarget.value })} />
          </div>
        </div>
      ) : null}

      <div className='field-row mt-3'>
        <Button variant='outline' size='sm' disabled={testing} onClick={() => void test()}>
          {testing ? '测试中…' : '测试出口'}
        </Button>
        <span className='detail'>{testResult}</span>
      </div>
    </div>
  )
}

/* ─── 账号设置弹窗 ───────────────────────────── */

/**
 * 「使用哪个套餐」：**只有 ZCode 账号有这一项**（见 accounts-domain 的
 * `supportsPlanChannel`），因此按能力位条件渲染。
 *
 * 两条通道是**两份独立的额度**，上游对「套餐已到期」的拒绝只由其中一条给出，
 * 所以这里必须由用户明确指定走哪条（详见后端 `providers::zcode::plan` 的模块头）。
 * 没有套餐登录态（jwt）时活动套餐那一项**仍可选中**但带一句说明 —— 禁用选项
 * 会让用户以为「这个功能不存在」，而实际问题是他需要重新登录一次。
 */
function PlanChannelField({
  plan, hasJwt, onChange,
}: {
  plan: string
  hasJwt: boolean
  onChange: (next: string) => void
}) {
  const current = zcodePlanLabel(plan)
  const [pool, setPool] = React.useState<{ ready?: number; target?: number } | null>(null)
  // 只在真的要用活动套餐时才盯着令牌池：编码套餐那条路不需要验证码令牌。
  // 5 秒一轮（与后台铸造器同一量级），弹窗关掉就停
  React.useEffect(() => {
    if (plan !== ZCODE_PLAN_START) return () => { /* 不需要轮询 */ }
    let alive = true
    const tick = () => {
      void Promise.resolve(shared().workbuddyDesktop?.zcodeCaptchaStats?.())
        .then(stats => { if (alive && stats) setPool({ ready: Number(stats.ready) || 0, target: Number(stats.target) || 0 }) })
        .catch(() => { /* 桥不可用时不给状态，不报错 */ })
    }
    tick()
    const timer = window.setInterval(tick, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [plan])
  return (
    <div className='field-row mt-2.5'>
      <label htmlFor='account-plan-channel'>使用套餐</label>
      <Select value={plan} onValueChange={value => onChange(String(value))}>
        <SelectTrigger id='account-plan-channel' className='min-w-[220px]'>
          {/* 显式传当前项的展示文案（不依赖 value 自动显示，见工程约定） */}
          <SelectValue>{current}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ZCODE_PLAN_CODING}>
            编码套餐（Coding Plan）— 走开放平台端点，用自己订阅的额度
          </SelectItem>
          <SelectItem value={ZCODE_PLAN_START}>
            活动套餐（Start Plan）— 走官方活动端点，用活动里领到的额度
          </SelectItem>
        </SelectContent>
      </Select>
      {plan === ZCODE_PLAN_START && !hasJwt ? (
        <span className='detail text-destructive'>
          该账号没有套餐登录态（jwt），活动套餐会失败：请重新登录该账号
        </span>
      ) : null}
      {plan === ZCODE_PLAN_START ? (
        <span className='detail' title='活动套餐的推理端点要求每条请求带一个阿里云验证码令牌；令牌由本应用在后台静默铸造，界面关闭时无法铸造'>
          验证码令牌：{pool ? `${pool.ready} / ${pool.target || 3}` : '读取中…'}
          {pool && pool.ready === 0 ? '（库存为空，正在补；补不上时转发会失败）' : ''}
        </span>
      ) : null}
    </div>
  )
}

/** 余额凭证行：**只有 CatPaw 账号有这一项**，所以按 provider 条件渲染 */
function BalanceTokenField({
  configured, value, onChange, onClear, clearBusy,
}: {
  configured: boolean
  value: string
  onChange: (next: string) => void
  onClear: () => void
  clearBusy: boolean
}) {
  return (
    <div className='field-row mt-2.5'>
      <label htmlFor='account-balance-token-input'>余额查询凭证</label>
      <Input id='account-balance-token-input' className='min-w-[220px]'
        placeholder={configured ? '已配置，留空则不修改' : '一般不用填'}
        title='积分查询已复用转发用的登录凭证，这里通常留空即可。只有旧版本填过、或从旧代理导入过凭证时才有值'
        value={value} onChange={event => onChange(event.currentTarget.value)} />
      {configured ? (
        <Button variant='outline' size='sm' disabled={clearBusy} onClick={onClear}
          title='清除已配置的余额查询凭证'>清除</Button>
      ) : null}
    </div>
  )
}

/** 自定义提供商的「提供商」一段（内置家不渲染：它们的协议与地址写在代码里） */
function ProviderSection({
  provider, name, protocol, baseUrl, count,
  onName, onProtocol, onBaseUrl, onRemove,
}: {
  provider: { id: string; name?: string; protocol?: string; baseUrl?: string }
  name: string
  protocol: string
  baseUrl: string
  count: number
  onName: (next: string) => void
  onProtocol: (next: string) => void
  onBaseUrl: (next: string) => void
  onRemove: () => void
}) {
  const protocols = shared().wbProviders?.PROTOCOL_OPTIONS || [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'anthropic', label: 'Anthropic' },
  ]
  const current = protocols.find(option => option.value === protocol)?.label || protocol
  return (
    <DialogSection>
      <h3>提供商</h3>
      <p>
        这一栏改的是<strong>「{provider.name || provider.id}」本身</strong>（名下 {count} 个账号共用）。
        改协议 / Base URL 会改变它们的转发方式，正在进行的请求可能失败；模型清单与映射在「模型管理」页。
      </p>
      <div className='field-row'>
        <label htmlFor='account-provider-name'>名称</label>
        <Input id='account-provider-name' maxLength={MAX_PROVIDER_NAME_CHARS} className='min-w-[220px]'
          placeholder={`提供商显示名，1~${MAX_PROVIDER_NAME_CHARS} 个字符`}
          value={name} onChange={event => onName(event.currentTarget.value)} />
      </div>
      <div className='field-row mt-2.5'>
        <label htmlFor='account-provider-protocol'>协议</label>
        <Select value={protocol} onValueChange={value => onProtocol(String(value))}>
          <SelectTrigger id='account-provider-protocol' className='min-w-[180px]'>
            <SelectValue>{current}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {protocols.map(option => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className='field-row mt-2.5'>
        <label htmlFor='account-provider-baseurl'>Base URL</label>
        <Input id='account-provider-baseurl' className='min-w-[260px]'
          placeholder='OpenAI 兼容填到 /v1；Anthropic 填根地址'
          value={baseUrl} onChange={event => onBaseUrl(event.currentTarget.value)} />
      </div>
      <div className='field-row mt-3'>
        <Button variant='destructive' onClick={onRemove}>删除提供商</Button>
        <span className='detail'>级联删除名下全部账号，不可恢复</span>
      </div>
    </DialogSection>
  )
}

export function AccountSettingsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const account = findAccount(id)
  const [priority, setPriority] = React.useState(String(account ? priorityOf(account) : 100))
  const [enabled, setEnabled] = React.useState(account?.enabled !== false)
  const [name, setName] = React.useState(account?.name || '')
  const [proxyDraft, setProxyDraft] = React.useState<ProxyDraft>(() => draftOfProxy(account?.proxy))
  const [balanceToken, setBalanceToken] = React.useState('')
  // ZCode 的「使用哪个套餐」草稿（非 ZCode 账号恒为空串，那一段也不渲染）
  const [planChannel, setPlanChannel] = React.useState(() => zcodePlanOf(account))
  const [busy, setBusy] = React.useState(false)
  const [status, setStatus] = React.useState<React.ReactNode>('')
  const [provider, setProvider] = React.useState<{ id: string; name?: string; protocol?: string; baseUrl?: string } | null>(null)
  const [providerName, setProviderName] = React.useState('')
  const [providerProtocol, setProviderProtocol] = React.useState('chat_completions')
  const [providerBaseUrl, setProviderBaseUrl] = React.useState('')

  // 「提供商」那一段：目录里查得到才算自定义家（id 前缀只说明「长得像」，而记录本身
  // 才带着协议 / Base URL 的现值 —— 三个字段要拿它预填）。
  // 依赖只取 id：弹窗是按 id 挂载的（父组件给了 key），账号数据刷新不该重置用户的编辑
  React.useEffect(() => {
    let alive = true
    setProvider(null)
    const account = findAccount(id)
    if (!account) return () => { alive = false }
    void Promise.resolve(shared().wbCustomProvidersUi?.find?.(providerOf(account))).then(found => {
      if (!alive || !found) return
      setProvider(found)
      setProviderName(found.name || '')
      setProviderProtocol(found.protocol || 'chat_completions')
      setProviderBaseUrl(found.baseUrl || '')
    }).catch(() => { /* 目录不可用：退化成「不是自定义家」，不注入那一段 */ })
    return () => { alive = false }
  }, [id])

  if (!account) {
    return (
      <Dialog open onOpenChange={next => { if (!next) onClose() }}>
        <DialogContent>
          <DialogHeader><DialogTitle>账号设置</DialogTitle></DialogHeader>
          <DialogBody><p className='detail'>账号不存在，请刷新后重试。</p></DialogBody>
          <DialogFooter><div className='mr-auto' /><Button variant='outline' onClick={onClose}>关闭</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  // 账号不存在时只给一块提示（列表可能刚被另一端删了）。用局部常量接住窄化后的账号：
  // 下面几个 async 函数声明会被提升，TS 不会把「早退之后的窄化」带进它们体内
  const target: AccountRecord = account
  const peers = peersOf(target, allAccounts())
  const numeric = Number(priority)
  const holder = Number.isFinite(numeric)
    ? peers.find(item => Number(item.priority) === clampPriority(numeric))
    : undefined
  const used = [...new Set(peers.map(item => Number(item.priority)))].sort((a, b) => a - b)
  const isCatpaw = providerOf(target) === 'catpaw'

  /** 清除余额凭证（立即落库，不走保存按钮 —— 它是一个独立的撤销动作） */
  async function clearBalanceToken(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await shared().workbuddyDesktop?.updateAccount?.(id, { balanceToken: null })
      setBalanceToken('')
      toast('✅ 已清除余额查询凭证')
      await shared().wbApp?.refresh?.()
    } catch (error) {
      toast(`清除失败：${errorMessage(error)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  /** 读「提供商」那一段的改动：没这一段（内置家）或三个字段都没动 → null（不提交） */
  function readProviderPatch(): { error: string } | { id: string; name: string; protocol: string; baseUrl: string } | null {
    if (!provider) return null
    const nextName = providerName.trim()
    const nextBase = providerBaseUrl.trim()
    // 空名称 / 空 Base URL 后端会 400，而那时**账号已经存下了** —— 用户看到「保存失败」
    // 却发现账号的改动生效了。所以在账号落库之前先验一遍
    if (!nextName) return { error: '请填写提供商名称' }
    if (!nextBase) return { error: '请填写提供商的 Base URL' }
    if (provider.name === nextName && provider.protocol === providerProtocol && provider.baseUrl === nextBase) return null
    return { id: provider.id, name: nextName, protocol: providerProtocol, baseUrl: nextBase }
  }

  async function save(): Promise<void> {
    if (busy) return
    let proxy: ProxyPayload
    try {
      proxy = readProxyDraft(proxyDraft)
    } catch (error) {
      toast(errorMessage(error), 'err')
      return
    }
    if (!Number.isFinite(numeric)) { toast('优先级必须是数字', 'err'); return }
    const clamped = clampPriority(numeric)
    if (holder) {
      setStatus(<span className='text-destructive'>优先级 {clamped} 已被同一提供商的「{labelOf(holder)}」占用，请换一个数值</span>)
      return
    }
    const providerPatch = readProviderPatch()
    if (providerPatch && 'error' in providerPatch) {
      setStatus(<span className='text-destructive'>{providerPatch.error}</span>)
      return
    }

    setBusy(true)
    try {
      // CatPaw 的余额凭证是**按需附加**的字段（别的家没有这一项，输入框也不存在）：
      // 空值 = 不修改（后端公开形态只给 hasBalanceToken 真假、不回显原值，所以这个
      // 输入框永远是空的；若把「空」解释成清除，用户每次保存设置都会把配好的凭证删掉）。
      // 清除走上面那个显式按钮。
      const balancePatch = isCatpaw && balanceToken.trim() ? { balanceToken: balanceToken.trim() } : {}
      // 套餐通道：只在**真的改了**时才带上（取值与后端 `zcode::normalize_plan`
      // 逐字一致）。带一个没变的键不会出错，但会让后端那句「套餐通道 → …」的
      // 变更提示在每次保存设置时都出现一次，看起来像刚改过
      const planPatch = supportsPlanChannel(target) && planChannel !== zcodePlanOf(target)
        ? { zcodePlan: planChannel }
        : {}
      await shared().workbuddyDesktop?.updateAccount?.(id, {
        name: name.trim() || target.name,
        priority: clamped,
        enabled,
        proxy,
        ...balancePatch,
        ...planPatch,
      })
      // 提供商那一段排在账号之后（账号是本弹窗的主角，先落库）。它失败时账号已经存下了，
      // 所以留在弹窗里把那句话说清楚 —— 笼统报成「保存失败」会把两件事混成一件
      if (providerPatch) {
        try {
          await shared().wbCustomProvidersUi?.update?.(providerPatch)
        } catch (error) {
          setStatus(<span className='text-destructive'>账号已保存，但提供商未更新：{errorMessage(error)}</span>)
          await shared().wbApp?.refresh?.()
          setBusy(false)
          return
        }
      }
      // 先关窗并反馈成功：改动已经落库，刷新只是让列表跟上，不该让用户对着「保存中…」
      // 再多等一次网络往返
      onClose()
      toast('✅ 账号设置已保存')
      // 保存后必须主动刷新列表：以前只关窗不刷新，行上的代理 / 优先级仍是旧数据，
      // 要等 20 秒那一轮轮询才更新 —— 用户看到的就是「保存完十几秒才变」。
      // 单独兜一层错：刷新失败只影响本次界面同步（后续轮询会自愈），不能掉进下面的
      // catch 被报成「保存失败」（保存其实已经成功了）
      try {
        await shared().wbApp?.refresh?.()
      } catch { /* 交给下一次轮询 */ }
    } catch (error) {
      // 后端校验失败（如优先级冲突）：留在弹窗里显示原因，方便直接改
      setStatus(<span className='text-destructive'>{errorMessage(error)}</span>)
      toast(`保存失败：${errorMessage(error)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const hint = holder
    ? <span className='text-destructive'>已被「{labelOf(holder)}」占用</span>
    : (used.length ? `同提供商已占用：${used.join('、')}` : '同提供商内暂无其他账号占用优先级')

  return (
    <Dialog open onOpenChange={next => {
      // 保存中不许关：关掉会让「到底存没存进去」变成未知状态
      if (next || busy) return
      onClose()
    }}>
      <DialogContent>
        <DialogHeader><DialogTitle>账号设置 · {labelOf(account)}</DialogTitle></DialogHeader>
        <DialogBody>
          <DialogSection>
            <h3>转发路由</h3>
            <p>
              优先级是转发顺序，数值越小越先用。<strong>同提供商内每个账号的优先级不能重号</strong>
              ——保存时会拒绝已被占用的数值。调整顺序也可以直接在账号列表里用「↑ / ↓」与相邻账号交换。
            </p>
            <div className='field-row'>
              <label htmlFor='account-priority-input'>优先级</label>
              <Input id='account-priority-input' type='number' min={PRIORITY_MIN} max={PRIORITY_MAX} step={1}
                className='max-w-[110px]' value={priority}
                onChange={event => setPriority(event.currentTarget.value)} />
              <span className='detail'>{hint}</span>
            </div>
            <div className='field-row mt-2.5'>
              <Label className='inline-flex cursor-pointer items-center gap-2.5 font-normal'>
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-label='启用该账号' />
                <span className='text-xs text-subtle'>启用该账号（关闭则不参与转发）</span>
              </Label>
            </div>
            <div className='field-row mt-2.5'>
              <label htmlFor='account-name-input'>备注名</label>
              <Input id='account-name-input' maxLength={100} placeholder='账号显示名称' className='min-w-[220px]'
                value={name} onChange={event => setName(event.currentTarget.value)} />
            </div>
            {isCatpaw ? (
              <BalanceTokenField configured={account.hasBalanceToken === true} value={balanceToken}
                onChange={setBalanceToken} clearBusy={busy}
                onClear={() => void clearBalanceToken()} />
            ) : null}
            {supportsPlanChannel(target) ? (
              <PlanChannelField plan={planChannel} hasJwt={account.canClaim === true}
                onChange={setPlanChannel} />
            ) : null}
          </DialogSection>

          {provider ? (
            <ProviderSection provider={provider} count={peers.length + 1}
              name={providerName} protocol={providerProtocol} baseUrl={providerBaseUrl}
              onName={setProviderName} onProtocol={setProviderProtocol} onBaseUrl={setProviderBaseUrl}
              onRemove={() => {
                if (busy) return
                // 删掉了就把本弹窗一起关掉（账号也没了）
                void Promise.resolve(shared().wbCustomProvidersUi?.remove?.(provider.id)).then(removed => {
                  if (removed) onClose()
                })
              }} />
          ) : null}

          <DialogSection>
            <h3>出网代理</h3>
            <p>默认无代理（直连上游）。需要经代理访问时可选择 Clash Verge 里的出口；端口由 Clash Verge 管理，这里每次实时读取。</p>
            <ProxyForm draft={proxyDraft} onChange={setProxyDraft} idPrefix='account-proxy' />
          </DialogSection>

          {account.proxy?.error ? (
            <div className='detail text-destructive'>
              当前代理不可用：{account.proxy.error}（转发时会回退直连）
            </div>
          ) : null}

          <div className='detail' style={{ minHeight: 18 }}>{status}</div>
        </DialogBody>
        <DialogFooter>
          <div className='mr-auto' />
          <Button variant='outline' disabled={busy} onClick={onClose}>取消</Button>
          <Button variant='default' disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── 批量操作弹窗 ───────────────────────────── */

const BATCH_ACTIONS = [
  { value: 'enable', label: '启用' },
  { value: 'disable', label: '禁用' },
  { value: 'proxy', label: '修改代理' },
  { value: 'remove', label: '删除' },
] as const

function BatchDialog({ ids, action, onClose }: { ids: string[]; action: string; onClose: () => void }) {
  const [current, setCurrent] = React.useState(action)
  const [proxyDraft, setProxyDraft] = React.useState<ProxyDraft>(() => draftOfProxy(null))
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<React.ReactNode>('')
  const accounts = ids.map(id => findAccount(id)).filter((account): account is AccountRecord => account !== null)

  /** 批量删除是不可逆操作，按数量做二次确认（原生 confirm 在 Tauri WebView 里直接放行） */
  function confirmBatchRemove(count: number): Promise<boolean> {
    return Promise.resolve(shared().wbConfirm?.ask?.({
      title: '删除选中的账号',
      html: `确定删除选中的 <strong>${count}</strong> 个账号？此操作不可恢复，账号的登录态会一并移除。`,
      okText: '删除',
      okClass: 'danger',
    }) ?? false)
  }

  async function run(): Promise<void> {
    if (busy) return
    if (!ids.length) { toast('没有选中的账号', 'err'); return }
    let proxy: ProxyPayload | undefined
    if (current === 'proxy') {
      try {
        proxy = readProxyDraft(proxyDraft)
      } catch (error) {
        toast(errorMessage(error), 'err')
        return
      }
    }
    if (current === 'remove' && !(await confirmBatchRemove(ids.length))) return

    // 批量禁用 / 删除可能把所有启用中的账号一起停掉，转发将无账号可用，提醒一下更稳妥。
    // 判据是「选中的账号是否已覆盖全部启用中的账号」，而不是数量对比 —— 否则勾了
    // 已禁用账号凑够数量也会误报
    if (current === 'disable' || current === 'remove') {
      const picked = new Set(ids)
      const survivors = allAccounts().filter(account => account.enabled !== false && !picked.has(account.id))
      if (!survivors.length) {
        const what = current === 'remove' ? '删除' : '禁用'
        const ok = await Promise.resolve(shared().wbConfirm?.ask?.({
          title: `全部启用中的账号将被${what}`,
          html: `这会<strong>${what}</strong>所有启用中的账号，转发将不可用。确定继续？`,
          okText: what,
          okClass: current === 'remove' ? 'danger' : 'primary',
        }) ?? false)
        if (!ok) return
      }
    }

    setBusy(true)
    setResult('')
    try {
      const payload: { action: string; ids: string[]; proxy?: unknown } = { action: current, ids }
      if (current === 'proxy') payload.proxy = proxy
      const data = await shared().workbuddyDesktop?.batchAccounts?.(payload)
      const okCount = (data?.ok || []).filter(item => item.changes?.length).length
      const removedCount = (data?.removed || []).length
      const failed = data?.failed || []
      const succeeded = current === 'remove' ? removedCount : okCount
      const verb = { enable: '启用', disable: '禁用', proxy: '修改代理', remove: '删除' }[current] || current
      if (failed.length) {
        const detail = failed.slice(0, 3).map(item => labelOf(findAccount(String(item.id))) || item.id).join('、')
        toast(`${verb}完成：成功 ${succeeded} 个，失败 ${failed.length} 个（${detail}${failed.length > 3 ? ' 等' : ''}）`, 'err')
        setResult(
          <span className='text-destructive'>失败 {failed.length} 个：
            {failed.map(item => `${labelOf(findAccount(String(item.id))) || item.id}（${item.error}）`).join('；')}
          </span>,
        )
      } else {
        toast(`✅ ${verb}完成：共 ${succeeded} 个账号`)
        onClose()
      }
      await shared().wbApp?.refresh?.()
    } catch (error) {
      setResult(<span className='text-destructive'>{errorMessage(error)}</span>)
      toast(`批量操作失败：${errorMessage(error)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const verb = { enable: '启用', disable: '禁用', proxy: '修改代理', remove: '删除' }[current] || current

  return (
    <Dialog open onOpenChange={next => { if (next || busy) return; onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>批量操作 · 已选 {ids.length} 个账号</DialogTitle></DialogHeader>
        <DialogBody>
          <DialogSection>
            <h3>将作用于以下账号</h3>
            <p style={{ maxHeight: 84, overflowY: 'auto' }}>{accounts.map(account => labelOf(account)).join('、')}</p>
          </DialogSection>
          <DialogSection>
            <h3>操作</h3>
            <RadioGroup value={current} onValueChange={setCurrent} className='flex-row flex-wrap items-center gap-5'
              aria-label='批量动作'>
              {BATCH_ACTIONS.map(item => (
                <Label key={item.value} className='inline-flex cursor-pointer items-center gap-2 font-normal'>
                  <RadioGroupItem value={item.value} />{item.label}
                </Label>
              ))}
            </RadioGroup>
            {current === 'proxy' ? (
              <div className='mt-2.5'>
                <ProxyForm draft={proxyDraft} onChange={setProxyDraft} idPrefix='batch-proxy' />
              </div>
            ) : null}
          </DialogSection>
          <div className='detail' style={{ minHeight: 18 }}>{result}</div>
        </DialogBody>
        <DialogFooter>
          <div className='mr-auto' />
          <Button variant='outline' disabled={busy} onClick={onClose}>取消</Button>
          <Button variant={current === 'remove' ? 'destructive' : 'default'} disabled={busy} onClick={() => void run()}>
            {busy ? '执行中…' : `执行（${verb}）`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── 供页面调用的入口 ───────────────────────── */

/**
 * 两个弹窗的宿主：按 store 里的 dialog 状态挂载。
 * 弹窗走组件库的 Dialog（Esc / 点遮罩关闭、焦点陷阱、滚动锁定都内建），关闭即卸载 ——
 * index.html 里那两个常驻的 `#account-modal` / `#batch-modal` 因此不再需要。
 */
export function AccountsDialogs() {
  const store = getStore()
  if (!store.dialog) return null
  if (store.dialog.kind === 'settings') {
    return <AccountSettingsDialog key={store.dialog.id} id={store.dialog.id} onClose={closeDialog} />
  }
  return <BatchDialog key={store.dialog.ids.join(',')} ids={store.dialog.ids} action={store.dialog.action}
    onClose={closeDialog} />
}
