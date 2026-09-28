/**
 * Agent2API · 模型管理页（左栏提供商导航 + 模型表 + 三个弹窗）—— React 岛。
 *
 * 替换 ui/models-panel.js + ui/models-reasoning.js + ui/models-custom-source.js 三个文件。
 * 对外接口与原实现**完全一致**（见 models-panel-state.ts 末尾的 window.wbModelsPanel）：
 * app.js:142 refreshAll() / app.js:570 render() / table-columns.js:74 visibleColumns() /
 * models-fetch-modal.tsx:274 builtinProviders() 与 :646 providerRefreshedAt()。
 *
 * 本文件只放**视图层**（页面骨架 + 左栏 + 模型表 + 映射 / 添加模型两个弹窗 + 挂载）；
 * 数据层（快照 store / 取数 / 写入 / 对外契约）在 models-panel-state.ts —— 那个文件不是岛
 * （.ts，不被 glob 加载）；「模型能力」弹窗自带一个文件（model-capability-dialog.tsx，它只
 * 依赖数据层，不依赖本文件）。
 *
 * ── 一个页面，两种数据源 ──────────────────────────────
 * 左栏（`.prov-rail`）是提供商导航：**内置提供商**一组（「全部」= 各家的聚合视图，各家是
 * 筛选视角）、**自定义提供商**一组（一家一项，一家一份清单）。选中谁，右栏就是谁家的模型表
 * —— 同一个表格骨架、同一批映射 chip 控件、同一套搜索与列设置。
 *
 * 两个数据源的差别只在取数与写入，渲染完全共用：
 *   · 内置家：`GET /api/models/manage`（`{models, mappings, reasoningLevels}`），写操作逐条
 *     即时生效（桥接的具名方法，都返回最新的同形数据，就地替换后重绘）；
 *   · 自定义家：目录缓存里该家记录的 models / mappings，由 models-custom-source.ts 适配成
 *     上面那个同形数据；写入是整表替换，于是体验与内置家一致 —— 点一下立即生效，没有保存
 *     按钮，也没有草稿态。
 * 本页自持内置家那份数据，不经过 app.js 的 state（那是 /api/session 的快照，轮询会整份覆盖）。
 *
 * ── 状态放模块级快照 + useSyncExternalStore（照 port-panel / update-panel）──
 * 对外契约方法（render / load / selectProvider / refreshAll）从 React 之外调用，且必须与
 * 界面共用同一份状态；组件内部的 useState 做不到这一点。所以状态是一份模块级快照，改动一律
 * 走 patch()（换新对象再通知订阅者），组件用 useSyncExternalStore 订阅它。
 * **选中项归一化放在 patch 里**而不是渲染期：渲染期改状态会与 React 的渲染顺序打架。
 *
 * ── 静态表头（本页最容易出错的地方）────────────────────
 * `index.html` 的 `<colgroup>` / `<thead>` 里带着 `col[data-col]` 与 `th[data-col]`，列的
 * 顺序与显隐靠 `wbColSettings.syncStaticHead` **就地重排既有元素**（隐藏的列是从 DOM 里摘掉
 * 而不是 display:none），不能按字符串重建：`<col>` 上带着 table-columns.js 拖出来的列宽，
 * `<th>` 里插着列宽把手，重建会把两者一起丢掉。
 *
 * 所以表骨架（colgroup + thead）在这里是**字面量 JSX**，永远按 index.html 的原始顺序渲染
 * 全部 7 列，且**不随任何状态变化**：
 *   · React 只在「同一位置、同一类型的子节点」上做属性 diff —— 这 7 个 th 的 props 与文本
 *     逐字不变，重渲染时 React 一次 DOM 写都不会发生，syncStaticHead 摘掉的列不会被 React
 *     塞回来（它压根不重新协调这几个节点）；
 *   · 隐藏列的元素在 syncStaticHead 的缓存里（按表 id 记住），切回内置家时放得回去；
 *   · 表元素本身在 JSX 里的位置固定（没有条件渲染包着它），表引用不会变，缓存不会失效。
 * 数据行（tbody）相反：完全由 React 按 `visibleColumns()` 逐列渲染，与表头读同一份配置。
 *
 * ── 控件替换（组件库）与刻意保留的旧实现 ────────────────
 * 换组件库：左栏导航项（NavItem）、面板头两颗按钮、状态筛选（SegmentedControl）、搜索框
 * （InputGroup）、chip 上的映射开关（Switch size='sm'）、chip 上的等级标与删除 ×（Button 的
 * 2xs / icon-2xs 档）、「＋ 映射」（Button variant='dashed'）、模型 ID 的复制按钮、展开/收起、
 * 行内「移除」、来源徽标（Badge）、三个弹窗整块（Dialog 一族 + Input / Select / Label / Tooltip；
 * 「模型能力」在 model-capability-dialog.tsx，能力位两列的单元格样式在 page-gateway.css）。
 * 保留旧实现的两处都不是控件本身：
 *   · 自定义家条目外层的 `.pv-row` 定位容器与那颗 `.pv-del` —— HTML 不允许 button 嵌套，
 *     删除 × 必须与 NavItem 做兄弟节点，靠 .pv-row 定位（见 rail 里的说明）；
 *   · chip 容器本身仍是 `span.alias` —— 它是药丸外壳而不是按钮，样式全在 page-gateway.css 里。
 * 另外：本页已经没有原生 `<select>`，所以不再调 `wbSelect.sync`（那个机制是给未迁移页面用的）。
 *
 * ── 数据行不用 `hidden` 属性隐藏 ────────────────────
 * 组件库的工具类是**分层 + !important** 的，tokens.css 的 `[hidden] { display:none !important }`
 * 未分层；按 Cascade 5，important 的层序反转 —— 分层压过未分层。本文件的显隐一律用条件渲染。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Label,
  NavItem,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from '@ui'
import { TableFooter, useClientPaging } from './table-shell'
import {
  BOOLEAN_KEYS, CAPABILITY_SHORT, capabilitiesOf, capabilityState, capabilityTip,
  exactTokens, formatTokens, normalizeOverrides,
} from './model-capability'
import { CapabilityDialog } from './model-capability-dialog'
import { CUSTOM_LEVEL, levels as reasoningLevels } from './models-reasoning'
import * as customSource from './models-custom-source'
import type { ManageModel, ManageView } from './models-custom-source'
import {
  GROUP_LIMIT, MODEL_STATE_OPTIONS, accept, bindingKeyOf, bindingsOf, builtinRailItems,
  closeCapability, closeCustomModel, closeMapping, collapseGroup, currentProvider, customProviderOptions,
  directoryReady, esc, errorMessage, expandGroup, formatTime, getSnapshot, levelOf, load, models,
  openAddCustomProvider, openCapability, openCustomModel, openMapping, providerOptions, refreshAll,
  refreshModels, registerColumnSettings, removeCustomProvider, render, resolveProvider, restoreSavedFilters,
  rowEnabled, rowKeyOf, runRowAction, same, selectProvider, setSearch, setStateFilter, setTableEl,
  shared, subscribe, syncHead, toast, upstreamOptions, viewData, visibleColumns, writeAddModel,
  writeBinding, writeModelState, writeRemoveMapping, writeRemoveModel,
  type Align, type Binding, type ColumnView, type CustomModelContext, type MappingContext,
} from './models-panel-state'


/* ─── 页面本体 ───────────────────────────────── */

/** 单元格的外壳类名（对齐由列设置给，三档互斥，与 table-col-settings 的 applyAlign 同一套） */
const cellClass = (base: string, align?: Align): string => (align ? `${base} ta-${align}` : base)

/**
 * 自定义家条目悬浮时把右侧计数让给删除 ×（两者占同一块位置，不藏就会叠字）。
 * 这条行为原来由 page-gateway.css 的 `.pv-row:hover .pv .n` 提供；换成 NavItem 之后计数是
 * 组件内部按 `data-slot` 渲染的 span，按 `.n` 类名命中的那条规则不再匹配，于是用工具类补回。
 * 只有带删除 × 的条目（自定义家）需要它，内置家不传。
 */
const RAIL_HIDE_COUNT_ON_HOVER = '[.pv-row:hover_&_[data-slot=nav-item-count]]:invisible'

/** 倍率文案：后端给的 `x1.5` 这类字符串只留数值部分（照抄旧实现） */
function formatCredits(credits: unknown): string {
  const match = /x\s*([\d.]+)/i.exec(String(credits || ''))
  return match ? `${match[1]}x` : String(credits || '')
}

/** 搜索 / 状态 / 提供商三个条件（口径与旧实现逐条对齐） */
function matches(model: ManageModel, keyword: string, provider: string, stateFilter: string): boolean {
  if (stateFilter === 'enabled' && !rowEnabled(model)) return false
  if (stateFilter === 'disabled' && rowEnabled(model)) return false
  if (stateFilter === 'mapped' && !(model.aliases || []).length) return false
  if (provider !== 'all' && (model.provider || '') !== provider) return false
  if (!keyword) return true
  const hay = [model.id, model.name, ...(model.aliases || [])].join(' ').toLowerCase()
  return hay.includes(keyword)
}

function ModelsPage() {
  const state = React.useSyncExternalStore(subscribe, getSnapshot)
  const provider = resolveProvider(state)
  const custom = customSource.isCustom(provider)
  /** 选中了一个已被删除的自定义家（目录缓存里确实没有这条记录，而不是「还没加载完」） */
  const customMissing = custom && directoryReady() && !customSource.record(provider)

  /**
   * 首屏一次性副作用：登记列设置（并注入按钮）→ 同步静态表头 → 补读筛选记忆 → 按需自拉。
   * app.js 末尾的 showPage() 跑在本岛之前：启动时若记住的就是本页，那次调用拿不到
   * wbModelsPanel，这里补一次整页刷新。
   */
  React.useEffect(() => {
    registerColumnSettings()
    syncHead()
    restoreSavedFilters()
    if (shared().wbApp?.currentPage === 'gateway') {
      // providers.js 排在岛之后加载：refreshAll 发起时它可能还没执行，那次目录刷新会被跳过。
      // 清单落地后补刷一次目录并重绘 —— 目录请求本身并发合并，不会重复打接口
      void refreshAll()
        .then(() => shared().wbProviders?.refreshCustom?.())
        .then(() => { render() })
    }
    // 只在挂载时跑一次（上面几个函数都读运行期单例，不需要跟着渲染重跑）
  }, [])

  const view = viewData()
  const all = Array.isArray(view.models) ? view.models : []
  const keyword = state.search.trim().toLowerCase()
  const shown = all.filter(model => matches(model, keyword, provider, state.stateFilter))
  const columns = visibleColumns()
  const columnCount = columns.length
  /**
   * 客户端分页（通用表格外壳）：一家的模型可能上百条，全渲染既慢又难扫。
   *
   * 默认 50 条/页。分页档位下**关掉组内折叠**（「展开其余 N 个」）：页数已经把
   * 长度限住了，两套折叠并存时读数会互相打架（标题写「Qoder 120 个模型」，页面上
   * 却只有 8 行）。选「全部」这一档时恢复原来的折叠行为，一个字都不变。
   */
  const paging = useClientPaging(shown.length, 'models')

  /** 左栏：内置提供商（全部 + 各家）+ 自定义提供商（每家 + 新建） */
  function rail() {
    const counts = builtinRailItems(state.data)
    const customs = customSource.list()
    const total = [...counts.values()].reduce((sum, item) => sum + item.n, 0)
    const allLabel = `全部（${counts.size} 家）`
    return (
      <aside className='prov-rail' id='prov-rail' aria-label='按提供商选择'>
        <div className='rail-label'>内置提供商</div>
        {/* 条目是导航项而不是按钮，走 NavItem（选中态 / 悬浮态 / 字重 / 计数都在组件里，
            与原来的 .pv 是同一套令牌取值）。shadow-none 是为了清掉 ui/css/components.css
            里通用 `button { box-shadow: var(--shadow-1) }` —— 平铺的导航列表不该有投影，
            .pv / .nav-item 原先也是显式清掉的 */}
        <NavItem active={provider === 'all'} data-provider='all' title={allLabel} count={total}
          className='shadow-none' onClick={() => selectProvider('all')}>{allLabel}</NavItem>
        {[...counts].map(([key, entry]) => (
          <NavItem key={key} active={provider === key} data-provider={key} title={entry.label}
            count={entry.n} className='shadow-none'
            onClick={() => selectProvider(key)}>{entry.label}</NavItem>
        ))}
        <div className='rail-label'>自定义提供商</div>
        {customs.length ? customs.map(item => {
          const id = String(item.id || '')
          const label = String(item.name || id)
          return (
            // 删除按钮不能嵌进 NavItem（button 套 button 是无效 HTML，解析器会把内层提到外面、
            // 绝对定位跟着失去参照），所以外面套一层定位容器，× 与条目做兄弟节点
            <div className='pv-row' key={id}>
              <NavItem active={provider === id} data-provider={id} title={label}
                count={Array.isArray(item.models) ? item.models.length : 0}
                className={cn('shadow-none', RAIL_HIDE_COUNT_ON_HOVER)}
                onClick={() => selectProvider(id)}>{label}</NavItem>
              <button type='button' className='pv-del' aria-label='删除自定义提供商'
                title='删除这个自定义提供商（连同名下账号）'
                onClick={() => void removeCustomProvider(id)}>×</button>
            </div>
          )
        }) : <div className='rail-empty'>还没有自定义提供商</div>}
        <NavItem variant='add' id='rail-add-custom'
          title='新建一个自定义提供商（同时创建它的第一个账号）'
          onClick={() => openAddCustomProvider()}>＋ 新建自定义提供商</NavItem>
      </aside>
    )
  }

  /** chip 上那枚等级标（未绑定时也渲染虚线样式，否则「怎么绑等级」会变成一个查不出的问题） */
  function levelBadge(alias: string, target: string, providerId: string, busy: boolean) {
    const level = levelOf(alias, target, providerId)
    return (
      // 16px 小件（2xs 档）：原来那枚 mono 10px 的小药丸。已绑定走实心档、未绑定走虚线档，
      // 与旧 CSS 的 `.alias-level` / `.alias-level.unset` 同一套语义（mono 粗体也照旧）；
      // shadow-none 是清掉通用 button 规则的投影（旧 CSS 同样显式清过）
      <Button variant={level ? 'secondary' : 'dashed'} size='2xs' disabled={busy}
        className='font-mono font-bold shadow-none'
        title={level ? `思考等级 ${level}（点击修改）` : '设置思考等级（当前未绑定）'}
        onClick={() => openMapping({ alias, target, provider: providerId })}>
        {level || '＋等级'}
      </Button>
    )
  }

  /** 映射 chips：每条 chip 属于自己所在的那一行（提供商 × 上游模型），删除时带三元组精确定位 */
  function aliasCell(model: ManageModel) {
    const providerId = model.provider || ''
    const bindings = bindingsOf(model)
    const [head, ...rest] = bindings

    /**
     * 删除一条映射：同名映射允许多条，按（对外名 + 上游模型 + 提供商）三元组定位。
     * 不用先弹确认框的那条路（等级标）见下 —— 它只写一个字段，保存前还能取消。
     */
    async function confirmUnmap(alias: string): Promise<void> {
      const ok = await shared().wbConfirm?.ask?.({
        title: '删除映射',
        html: `确定删除映射「<strong>${esc(alias)} → ${esc(model.id)}</strong>」？`,
        okText: '删除',
        okClass: 'danger',
      })
      if (!ok) return
      void runRowAction(
        bindingKeyOf(alias, model.id, providerId),
        () => writeRemoveMapping(providerId, alias, model.id),
        '映射已删除',
      )
    }

    const chip = (binding: Binding) => {
      const alias = binding.alias
      const on = binding.enabled !== false
      const busy = state.pending.has(bindingKeyOf(alias, model.id, providerId))
      return (
        <span className={cn('alias', !on && 'map-off')} key={`${alias}\u0001${binding.isDefault ? 'd' : 'm'}`}>
          {/* 映射自己的开关（关掉 = 这条别名暂时不存在，可再打开）。行禁用时 chips 随行压淡，
              映射开关另用 map-off 弱化 —— 两个维度独立，一眼可辨。size='sm' 是 24×14 的小号，
              与旧 CSS 里 `.alias .switch .track` 同尺寸：标准档（36×21）塞进 22px 的药丸里
              会把 chip 连同整张表的行高一起撑高 */}
          <Switch size='sm' checked={on} disabled={busy}
            title={on ? '映射已启用，点击关闭' : '映射已关闭，点击启用'}
            aria-label={`${on ? '关闭' : '启用'}映射 ${alias}`}
            onCheckedChange={next => {
              void runRowAction(
                bindingKeyOf(alias, model.id, providerId),
                () => writeBinding(providerId, alias, model.id, { enabled: next }),
                next ? '映射已启用' : '映射已关闭',
              )
            }} />
          {/* 名字本身就是复制入口（data-copy 走 clipboard.js 的全局委托，点一下
              toast「已复制」）；title 同时承担两件事 —— 提示可点、长名字被
              ellipsis 截断时悬停能看全 */}
          <span className='t' data-copy={alias} title={`点击复制：${alias}`}>{alias}</span>
          {binding.isDefault ? <span className='binding-default'>默认</span> : null}
          {levelBadge(alias, model.id, providerId, busy)}
          {binding.isDefault ? null : (
            // 16px 的删除小件（icon-2xs 档）：字号 / 行高照旧 CSS 的 `.alias .x` 给，
            // 免得 × 跟着 chip 的 11px 一起缩水
            <Button variant='ghost' size='icon-2xs' className='text-[12px] leading-none'
              disabled={busy} title={`删除映射 ${alias}`}
              onClick={() => void confirmUnmap(alias)}>×</Button>
          )}
        </span>
      )
    }
    // 「＋ 映射」并排跟在**默认**那条右边（它是这一列的入口，不是一条绑定）：默认绑定永远
    // 存在（没有映射时是合成出来的那条），所以这一行永远有内容
    return (
      <div className='aliases'>
        <div className='alias-row'>
          {head ? chip(head) : null}
          {/* dashed = 「这里还能再添一个」的入口语义（对应旧的 .alias-add），与旁边那些
              实心按钮一眼分开 */}
          <Button variant='dashed' size='xs'
            onClick={() => openMapping({ target: model.id, provider: providerId })}>＋ 映射</Button>
        </div>
        {rest.map(chip)}
      </div>
    )
  }

  /** 「来源」列：这一家的清单当前是远程拉的还是内置静态表（后端给的 source，前端只做文案映射） */
  function sourceCell(model: ManageModel) {
    if (model.source === 'manual') {
      return <Badge variant='brand' shape='tag' title='手动登记的上游模型；移除它会直接删掉这条登记'>手动</Badge>
    }
    if (model.source !== 'remote' && model.source !== 'builtin') return <span className='rate'>—</span>
    const remote = model.source === 'remote'
    const at = formatTime(Number(model.refreshedAt) || 0)
    const hint = remote
      ? `来自上游目录接口${at ? `，清单拉取于 ${at}` : ''}；刷新失败时保留上一份成功结果`
      : '上游目录尚未拉到，用的是内置静态清单；点「刷新模型清单」可重试'
    return <Badge variant={remote ? 'brand' : 'outline'} shape='tag' title={hint}>{remote ? '远程' : '内置'}</Badge>
  }

  /**
   * 「上下文 / 输出」列：两个 token 数合在一格（上下文 / 最大输出）。
   *
   * 展示的是**生效值**（清单原值 + 覆盖，归一后读）；被覆盖过的那一项挂一枚
   * 小点（`.cap-mark`，title 说明），未声明的显示 `—`。整格是一个按钮：
   * 点它打开能力弹窗（两列入口同一个 —— 能力是一个整体，没必要各开一个）。
   */
  function budgetCell(model: ManageModel) {
    const caps = capabilitiesOf(model)
    const overrides = normalizeOverrides(model.capOverrides)
    const input = typeof caps.maxInputTokens === 'number' ? caps.maxInputTokens : null
    const output = typeof caps.maxOutputTokens === 'number' ? caps.maxOutputTokens : null
    const hint = `上下文窗口 ${exactTokens(input)} / 最大输出 Token ${exactTokens(output)} —— 点击修改模型能力`
    return (
      <button type='button' className='caps-open' title={hint}
        onClick={() => openCapability(model.provider || '', model.id)}>
        <span className={cn('cap-num', input === null && 'unset')}>
          {formatTokens(input)}
          {overrides.includes('maxInputTokens') ? <i className='cap-mark' title='已覆盖上游值' /> : null}
        </span>
        <span className='cap-sep'>/</span>
        <span className={cn('cap-num', output === null && 'unset')}>
          {formatTokens(output)}
          {overrides.includes('maxOutputTokens') ? <i className='cap-mark' title='已覆盖上游值' /> : null}
        </span>
      </button>
    )
  }

  /**
   * 「能力」列：四枚布尔徽章（工具 / 图片 / 视频 / 思考），三态各有一副样式 ——
   * 支持（实心）/ 明确不支持（压淡）/ 未声明（虚线）。悬停出完整文案
   * （`capabilityTip` 会写明「上游未声明时下游按不支持处理」这类事实）。
   */
  function capsCell(model: ManageModel) {
    const caps = capabilitiesOf(model)
    const overrides = normalizeOverrides(model.capOverrides)
    return (
      <button type='button' className='caps-open caps-badges'
        title='对下游声明的能力（工具调用 / 图片识别 / 视频识别 / 支持思考）—— 点击修改'
        onClick={() => openCapability(model.provider || '', model.id)}>
        {BOOLEAN_KEYS.map(key => {
          const value = caps[key] ?? null
          const state = capabilityState(value)
          const overridden = overrides.includes(key)
          return (
            <span key={key} className={cn('cap-badge', state, overridden && 'marked')}
              title={capabilityTip(key, value, overridden)}>
              {CAPABILITY_SHORT[key]}
              {overridden ? <i className='cap-mark' /> : null}
            </span>
          )
        })}
      </button>
    )
  }

  /**
   * 各列的单元格（不含对齐类）。放在一个 switch 里而不是行内联的三元链，是为了让「某一列长
   * 什么样」只有一处实现 —— 列设置重排时才不会各画一个样。
   *
   * 操作列只移除「可移除的」：内置家里是手动登记的那些（source=manual，上游目录带来的行由
   * 清单决定存在性，开关才是它的手段），自定义家里每一行都是用户自己登记进来的、都可以移除。
   * 对外名称统一在模型映射列切换。
   */
  function cellFor(column: ColumnView, model: ManageModel, busyRow: boolean) {
    /**
     * 「移除」删掉的是那条**登记**（它的存在完全由这次登记决定，没有「上游刷新会把它带回来」
     * 这回事，移除后 /v1/models、路由同时消失）。判据用后端给的 source，前端不自己推断。
     */
    async function confirmRemoveModel(): Promise<void> {
      const ok = await shared().wbConfirm?.ask?.({
        title: '移除自定义模型',
        html: `确定移除自定义模型「<strong>${esc(model.id)}</strong>」？这条登记会被<b>直接移除</b>，之后 <code>/v1/models</code> 不再广告它、请求它也会被拒。`,
        okText: '移除',
        okClass: 'danger',
      })
      if (!ok) return
      void runRowAction(
        rowKeyOf(model),
        () => writeRemoveModel(model.provider || '', model.id),
        custom ? '模型已移除' : '自定义模型已移除',
      )
    }

    switch (column.key) {
      case 'model':
        return (
          <td className={cellClass('cell-model', column.align)}>
            {/* 名字本身就是复制入口（data-copy 走 clipboard.js 的全局委托，点一下
                toast「已复制」）；title 同时承担两件事 —— 提示可点、长 ID 被
                ellipsis 截断时悬停能看全。曾经这里另挂一颗 ⧉ 小按钮，已去掉：
                点名字更省事，也少一个悬停才显形的控件 */}
            <div className='mid'>
              <span className='t' data-copy={model.id} title={`点击复制：${model.id}`}>{model.id}</span>
            </div>
            {model.name && model.name !== model.id ? <div className='mname'>{model.name}</div> : null}
          </td>
        )
      case 'rate':
        return (
          <td className={cellClass('cell-rate', column.align)}>
            <span className='rate'>{model.credits ? formatCredits(model.credits) : '—'}</span>
            {/* 福利池模型：那一列往往是 `—`（上游不给倍率），光看列分不清「没读到」
                与「不花钱」—— 这个标把后者标出来（走福利池、不扣积分）。 */}
            {model.benefit ? (
              <span className='binding-default'
                title='走福利池：不扣积分，只受福利日额度限制'>福利</span>
            ) : null}
          </td>
        )
      case 'source':
        return <td className={cellClass('cell-source', column.align)}>{sourceCell(model)}</td>
      case 'budget':
        return <td className={cellClass('cell-budget', column.align)}>{budgetCell(model)}</td>
      case 'caps':
        return <td className={cellClass('cell-caps', column.align)}>{capsCell(model)}</td>
      case 'alias':
        return <td className={cellClass('cell-alias', column.align)}>{aliasCell(model)}</td>
      case 'act':
        return (
          <td className={cellClass('cell-act r', column.align)}>
            <div className='row-actions'>
              {/* 模型启停（只给内置家）：关掉 = 不广告（/v1/models 看不到）+ 请求它 404
                  + 不参与路由，但这一行仍在管理页可见（开关关着）—— 「不想用」是收起来，
                  不是删掉，下次拉取还在、随时能再打开。
                  自定义家的启停走它自己的编辑弹窗（见 models-custom-source），
                  所以这里不给它们渲染开关（渲染了也调不动 modelRules）。 */}
              {custom ? null : (
                <Switch size='sm' checked={rowEnabled(model)} disabled={busyRow}
                  title={rowEnabled(model)
                    ? '已启用，点击禁用（不再对外提供）'
                    : '已禁用，点击启用'}
                  aria-label={`${rowEnabled(model) ? '禁用' : '启用'}模型 ${model.id}`}
                  onCheckedChange={next => {
                    void runRowAction(
                      rowKeyOf(model),
                      () => writeModelState(model.provider || '', model.id, next),
                      next ? '模型已启用' : '模型已禁用（不再对外提供）',
                    )
                  }} />
              )}
              {model.source === 'manual' || custom ? (
                <Button variant='ghost' size='sm' className='text-destructive' disabled={busyRow}
                  onClick={() => void confirmRemoveModel()}>移除</Button>
              ) : null}
            </div>
          </td>
        )
      default:
        return null
    }
  }

  function modelRow(model: ManageModel) {
    const busyRow = state.pending.has(rowKeyOf(model))
    return (
      <tr key={`${model.provider || ''}\u0001${model.id}`}>
        {columns.map(column => (
          <React.Fragment key={column.key}>{cellFor(column, model, busyRow)}</React.Fragment>
        ))}
      </tr>
    )
  }

  /**
   * 表体：空态 / 无匹配 / 分组（「全部」视图里按提供商分组，顺序 = 后端数组顺序 = 路由优先级）。
   * 有搜索词或非「全部」的状态筛选时不折叠：用户在找东西，藏起来只会让他以为没有。
   */
  function body() {
    if (!all.length) {
      // 一条模型都没有：内置家是「还没加账号」，自定义家是「还没登记 / 还没拉取」。
      // 说清下一步该做什么才有用；目录还没就位时既不能说「已删除」也不能说「还没有模型」
      const empty = custom
        ? (!directoryReady()
          ? '加载中…'
          : customMissing
            ? '该提供商已不存在（可能已被删除），请刷新列表'
            : '这家还没有模型：点「添加模型」登记，或「获取上游模型」从上游拉取')
        : (state.data ? '暂无模型（请先添加账号）' : '加载中…')
      return <tr><td colSpan={columnCount} className='empty'>{empty}</td></tr>
    }
    if (!shown.length) {
      return <tr><td colSpan={columnCount} className='empty'>{keyword ? `没有匹配「${keyword}」的模型` : '没有匹配当前筛选的模型'}</td></tr>
    }
    // 分组带只在「全部」视图里出现：选中单家时标题已经写了是哪一家，再叠一条是重复的
    const showGroups = provider === 'all'
    // 分页档位下**不做组内折叠**（见 paging 的说明）：页数本身就把长度限住了，
    // 两套折叠叠在一起会让人算不清「到底还有多少个」。选「全部」时保持原行为。
    const collapsible = showGroups && !keyword && state.stateFilter === 'all' && !paging.paged
    const groups = new Map<string, { label: string; items: ManageModel[] }>()
    for (const model of shown) {
      const key = model.provider || ''
      if (!groups.has(key)) groups.set(key, { label: model.providerLabel || key || '未知', items: [] })
      groups.get(key)?.items.push(model)
    }
    const rows: React.ReactNode[] = []
    /** 全局「模型行」序号：分页区间按**模型行**算，组标题与「更多」行不占号 */
    let rowIndex = 0
    for (const [key, group] of groups) {
      // 组内排序：禁用的行沉到该组末尾，启用的排前面；Array#sort 稳定，组内仍按后端原序
      //（判定与「已启用 / 已禁用」筛选同一份，见 rowEnabled）
      group.items.sort((a, b) => Number(!rowEnabled(a)) - Number(!rowEnabled(b)))
      const open = state.expanded.has(key) || !collapsible
      const items = open ? group.items : group.items.slice(0, GROUP_LIMIT)
      const rest = group.items.length - items.length
      // 本组落在当前页里的那一段（分页关掉时就是全部）
      const from = paging.paged ? Math.max(0, paging.rangeStart - 1 - rowIndex) : 0
      const to = paging.paged ? Math.min(items.length, paging.rangeEnd - rowIndex) : items.length
      const onPage = from < to ? items.slice(from, to) : []
      // 组标题：本组在这一页上有行才渲染。跨页续上的那一组缀「（续）」—— 否则读者会
      // 以为这一组只有当前页这几个（标题上的总数仍是**整组**的，不是这一页的）
      if (showGroups && onPage.length) {
        rows.push(
          <tr className='tr-group' key={`group:${key}`}>
            <td colSpan={columnCount}>
              <span className='prov-tag'>{group.label}</span>{from > 0 ? '（续）' : ''}{group.items.length} 个模型
            </td>
          </tr>,
        )
      }
      for (const model of onPage) rows.push(modelRow(model))
      rowIndex += items.length
      if (rest > 0) {
        rows.push(
          <tr className='tr-more' key={`more:${key}`}>
            <td colSpan={columnCount}>
              <Button variant='ghost' size='sm' onClick={() => expandGroup(key)}>展开其余 {rest} 个模型 ▾</Button>
            </td>
          </tr>,
        )
      } else if (open && collapsible && group.items.length > GROUP_LIMIT) {
        rows.push(
          <tr className='tr-more' key={`collapse:${key}`}>
            <td colSpan={columnCount}>
              <Button variant='ghost' size='sm' onClick={() => collapseGroup(key)}>收起 ▴</Button>
            </td>
          </tr>,
        )
      }
    }
    return rows
  }

  return (
    <>
      <section className='panel'>
        <div className='mm'>
          {rail()}
          <div className='mm-main'>
            <div className='panel-head'>
              {/* 状态筛选：语义、键盘、滑块都在组件库里，取值仍以快照为准（完全受控） */}
              <SegmentedControl options={MODEL_STATE_OPTIONS} value={state.stateFilter}
                onValueChange={setStateFilter} aria-label='按状态筛选' className='shrink-0' />
              {/* 搜索框：InputGroup + addon 图标（与 input-control.tsx 的用法一致）。
                  刻意**不带** data-island-input：那是输入框岛（就地升级）的钩子，
                  两个岛同时挂一个输入框会打架。宽度沿用旧 CSS 的 #models-search 240px */}
              <InputGroup className='w-[240px] flex-none' id='models-search'>
                <InputGroupInput type='search' placeholder='搜索模型 ID / 名称 / 映射名…'
                  aria-label='搜索模型' autoComplete='off' value={state.search}
                  onChange={event => setSearch(event.currentTarget.value)} />
                <InputGroupAddon aria-hidden='true'>⌕</InputGroupAddon>
              </InputGroup>
              <div className='head-actions'>
                {/* 「获取模型」排在最前：它是这一页的主操作（把清单拉回来），「添加模型」是补充。
                    文案与 title 只有一处事实来源（这里），index.html 里不写死 */}
                <Button id='btn-refresh-models' variant='outline' size='sm'
                  title={custom
                    ? '从这一家的上游拉一份模型清单，勾选要哪些再导入（已添加的不会重复导入）'
                    : '刷新模型管理页里各提供商的远程模型目录，逐家结果列在弹窗里'}
                  onClick={() => refreshModels()}>获取模型</Button>
                <Button id='btn-add-custom-model' variant='outline' size='sm'
                  onClick={() => openCustomModel()}>＋ 添加模型</Button>
                {/* 「列设置」按钮由 wbColSettings.register 追加到这个容器的末尾（React 不接管它） */}
              </div>
            </div>
            <div className='models-table-wrap'>
              {/* 表骨架（colgroup + thead）是**字面量**、永远按 index.html 的原始顺序渲染全部
                  5 列、不随任何状态变化：列的显隐与顺序由 wbColSettings.syncStaticHead 就地
                  重排（隐藏 = 从 DOM 摘掉，不能重建 —— <col> 上带着拖出来的列宽、<th> 里插着
                  列宽把手）。React 只在同一位置同类型的子节点上做属性 diff，这几个 th 的
                  props 与文本逐字不变，重渲染时一次 DOM 写都不会发生，摘掉的列不会被塞回来。
                  数据行相反：完全按 visibleColumns() 逐列渲染，与表头读同一份配置。 */}
              <table className='models-table' ref={el => setTableEl(el)}>
                <colgroup>
                  <col className='c-model' data-col='model' />
                  <col className='c-rate' data-col='rate' />
                  <col className='c-source' data-col='source' />
                  <col className='c-budget' data-col='budget' />
                  <col className='c-caps' data-col='caps' />
                  <col className='c-alias' data-col='alias' />
                  <col className='c-act' data-col='act' />
                </colgroup>
                <thead><tr>
                  <th data-col='model'>上游模型</th>
                  <th data-col='rate'>倍率</th>
                  <th data-col='source'>来源</th>
                  <th data-col='budget'>上下文 / 输出</th>
                  <th data-col='caps'>能力</th>
                  <th data-col='alias'>模型映射（原始 ID 与别名独立开关）</th>
                  <th className='r' data-col='act'>操作</th>
                </tr></thead>
                <tbody id='models'>{body()}</tbody>
              </table>
            </div>
            {/* 表尾：读数 / 每页条数 / 跳页 / 翻页器由通用表格外壳（table-shell.tsx）统一渲染。
                左侧说明只剩「自定义家」那一条（内置家原先那句按用户要求移除）；其余四张表
                的页脚说明也都去掉了，页脚现在是清一色的控制条 */}
            <TableFooter
              className='models-panel-foot'
              leading={custom
                ? <>自定义提供商的清单<b>只属于这一家</b>：这里的模型不会出现在其他家，别名也只在这一家内生效。改名称 / 协议 / Base URL 在账号页该家账号的「设置」→ 提供商一栏；整家不要了，鼠标移到左栏这家上点 × 删除（连同名下账号）。</>
                : undefined}
              total={shown.length}
              range={paging.paged ? { start: paging.rangeStart, end: paging.rangeEnd } : null}
              page={paging.page}
              pageCount={paging.pageCount}
              size={paging.size}
              onSizeChange={paging.setSize}
              onPageChange={paging.goto}
            />
          </div>
        </div>
      </section>
      {/* 弹窗走 Dialog（Esc / 点遮罩关闭、焦点陷阱、滚动锁定都内建），按需挂载、关闭即卸 */}
      {state.mapping ? <MappingDialog context={state.mapping} onClose={closeMapping} /> : null}
      {state.customModel
        ? <CustomModelDialog initial={state.customModel} onClose={closeCustomModel} />
        : null}
      {state.capability
        ? <CapabilityDialog context={state.capability} onClose={closeCapability} />
        : null}
    </>
  )
}

/* ─── 映射弹窗 ───────────────────────────────── */

/** 弹窗里问号那枚说明（原文照抄 index.html 的 data-tip，别删条目 —— 每一条都是踩过的边界） */
const REASONING_TIP = '绑定在「对外名 → 上游模型」这一条映射上的思考等级（列表照抄 OmniProxy 的手动绑定），选「不覆盖」表示不给这条映射指定等级。它会跟着这条映射注入转发，由承载的那家翻译成自己的档位字段（CatPaw 归并成 low/high/max，Qoder 按模型声明的档位归一）。以下几种情况故意不注入：① off / none（关闭思考）—— 本项目没有安全的表达方式；② 表外的自定义等级（各家能力范围不同，无法判断上游收不收）；③ 客户端请求体里已经自己指定了档位（那是更明确的意图，绑定不覆盖）；④ 这家上游不认识档位字段（如 WorkBuddy / 小浣熊 / AutoClaw / Cline）。注入与跳过都会写进详细日志。'

/** 上游下拉的初值：候选里有就用候选里的原始拼写（value 必须与 option 逐字相同才会选中） */
function pickUpstream(providerId: string, keep: string, locked: boolean): string {
  const options = upstreamOptions(providerId)
  const wanted = (keep || '').trim()
  const hit = options.find(item => item.id.toLowerCase() === wanted.toLowerCase())
  if (hit) return hit.id
  // 锁定态**保住** keep：孤儿映射的 target 恰恰常常不在该家清单里（那正是它挂不上行的原因），
  // 丢掉它会让「设置思考等级」保存时把三元组换成另一个模型，等级存到错的地方而界面上看不出异常
  if (locked && wanted) return wanted
  return options[0]?.id || ''
}

/**
 * 映射弹窗。入口只剩行内两处 —— 行尾「＋ 映射」新建、点别名 chip 改等级 —— 所以 context
 * 总是带着这一行的身份：提供商与上游模型锁定（改了就变成另一条映射），`context.alias` 有值时
 * 连对外名也锁定，只留等级可动（「设置思考等级」形态）。
 *
 * 上游模型**只能是下拉**（数据来自该家当前清单）。这里曾经放开过「手动输入上游模型 ID」，
 * 已删除：对外名只有在目标模型已被广告时才会跟着进广告视图，而入口校验以广告视图为准 ——
 * 手输一个清单里没有的名字，映射建了也永远调不通。要用清单外的模型，正确做法是顶部的
 * 「＋ 添加模型」把它登记进该家清单，之后它自然出现在这里的下拉里。
 */
function MappingDialog({ context, onClose }: { context: MappingContext; onClose: () => void }) {
  const editing = Boolean(context.alias)
  const [provider, setProvider] = React.useState(() => context.provider || providerOptions()[0]?.id || '')
  const [alias, setAlias] = React.useState(context.alias || '')
  // 初值用上面那个 provider（context.provider 为空时它已经落到了首项），两者必须同源
  const [upstream, setUpstream] = React.useState(() => pickUpstream(provider, context.target, true))
  const [status, setStatus] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  /**
   * 思考等级：`select` 是下拉的当前值（'' = 不覆盖 / 某个等级 / CUSTOM_LEVEL），`custom` 是
   * 自定义输入框里的字。keep 不在候选里（用户上次填的自定义值、或后端调整过候选表）时落到
   * 「自定义」那一项并把值填进输入框 —— 直接丢掉会让「改别的字段时顺手把等级抹掉」。
   */
  const [reasoning, setReasoning] = React.useState(() => {
    const candidates = reasoningLevels(getSnapshot().data)
    const current = editing ? levelOf(context.alias, context.target, context.provider) : ''
    if (current && candidates.includes(current)) return { select: current, custom: '' }
    return { select: current ? CUSTOM_LEVEL : '', custom: current }
  })

  const candidates = reasoningLevels(getSnapshot().data)
  /** 提供商候选：表格里出现过的家，再补上上下文那一家（孤儿映射可能属于「整个没进表格」的家） */
  const providerChoices = (() => {
    const options = providerOptions()
    for (const id of [context.provider, provider]) {
      if (id && !options.some(item => item.id === id)) {
        options.push({ id, label: shared().wbProviders?.labelOf?.(id) || id })
      }
    }
    return options
  })()
  /** 上游候选：锁定态下 keep 不在清单里时补进去（见 pickUpstream 的说明） */
  const upstreamChoices = (() => {
    const options = upstreamOptions(provider)
    const wanted = (upstream || '').trim()
    if (wanted && !options.some(item => item.id.toLowerCase() === wanted.toLowerCase())) {
      options.unshift({ id: wanted, label: `${wanted}（不在该家当前清单里）`, off: true })
    }
    return options
  })()

  const providerLabel = providerChoices.find(item => item.id === provider)?.label || provider || '(全局)'
  const level = reasoning.select === CUSTOM_LEVEL ? reasoning.custom.trim() : reasoning.select
  const showCustomLevel = reasoning.select === CUSTOM_LEVEL

  /** 换了一家，上游候选整体换掉（保留同名项，切回来时不用重选） */
  function changeProvider(next: string): void {
    setProvider(next)
    setUpstream(pickUpstream(next, upstream, true))
  }

  async function save(): Promise<void> {
    if (saving) return
    const wanted = editing ? (context.alias || '') : alias.trim()
    const target = upstream
    if (!wanted) { setStatus('请填写对外映射名'); return }
    // 下拉为空 = 这一家清单里一个模型都没有（还没加账号 / 清单没拉到）
    if (!target) { setStatus('该提供商当前没有可选的上游模型'); return }
    if (!provider) { setStatus('请选择提供商'); return }
    if (!editing && same(wanted, target)
      && models().some(model => same(model.id, target) && same(model.provider, provider))) {
      setStatus('原始 ID 已作为默认绑定，请直接使用该绑定的开关或等级按钮')
      return
    }
    setSaving(true)
    setStatus('保存中…')
    try {
      // `reasoning` **总是显式给出**（空串 = 清空绑定）：三元组相同走的也是这条接口，而用户
      // 在这个弹窗里看到的就是他要的结果 —— 传 undefined（= 不改）会让「从 high 改成不覆盖」
      // 这一步静默无效
      accept(await writeBinding(provider, wanted, target, { reasoning: level }))
      setSaving(false)
      onClose()
      const suffix = level ? ` · 思考等级 ${level}` : ''
      // 展示名走注册表 / 自定义目录：直接印 provider id 时，自定义家会显示成一串
      // custom-3f2a91b04c7e，用户认不出是哪一家
      const label = shared().wbProviders?.labelOf?.(provider) || provider
      toast(editing ? `✅ 已更新 ${wanted} 的思考等级` : `✅ 已添加映射 ${wanted} → ${target}（${label}）${suffix}`)
    } catch (error) {
      setStatus(`保存失败：${errorMessage(error)}`)
      setSaving(false)
    }
  }

  const onEnter = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void save()
  }

  return (
    <Dialog open onOpenChange={(next, eventDetails) => {
      if (next) return
      // 保存中不许关：关掉会让「到底存没存进去」变成未知状态。必须走 eventDetails.cancel()
      // —— 光「不更新 open prop」拦不住 Base UI 的 store
      if (saving) { eventDetails.cancel(); return }
      onClose()
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? '设置思考等级' : '添加模型映射'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='mapping-provider'>提供商</Label>
            {/* 锁定 = 行内入口：提供商与上游模型就是这一行，不允许改 */}
            <Select value={provider} disabled onValueChange={next => changeProvider(String(next))}>
              <SelectTrigger id='mapping-provider' className='w-full'>
                <SelectValue>{providerChoices.find(item => item.id === provider)?.label || provider}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providerChoices.map(item => (
                  <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='grid grid-cols-[1fr_24px_1fr] items-end gap-2.5'>
            <div className='flex min-w-0 flex-col gap-1.5'>
              <Label htmlFor='mapping-alias'>对外映射名（下游请求时用）</Label>
              <Input id='mapping-alias' maxLength={128} placeholder='例如 gpt-4o' autoComplete='off'
                autoFocus={!editing} value={alias} disabled={editing}
                onChange={event => setAlias(event.currentTarget.value)} onKeyDown={onEnter} />
            </div>
            <div className='pb-2 text-center text-muted-foreground'>→</div>
            <div className='flex min-w-0 flex-col gap-1.5'>
              <Label htmlFor='mapping-upstream'>转发到上游模型</Label>
              <Select value={upstream} disabled onValueChange={next => setUpstream(String(next))}>
                <SelectTrigger id='mapping-upstream' className='w-full'>
                  <SelectValue>{upstreamChoices.find(item => item.id === upstream)?.label || upstream}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {upstreamChoices.map(item => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}{item.off ? '（已禁用）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* 预览：当前选择会变成哪一条映射（等级一起显示，保存前就能核对） */}
          <div className='rounded-md border border-border bg-surface-inset px-3 py-2.5 font-mono text-[12px] text-subtle'>
            下游请求 <b className='text-primary-fg'>{alias.trim() || '<对外名>'}</b> → 转发{' '}
            <b className='text-primary-fg'>{upstream || '<上游模型>'}</b>（{providerLabel}）
            {level ? <> · 思考等级 <b className='text-primary-fg'>{level}</b></> : null}
          </div>
          <div className='flex flex-col gap-1.5'>
            <div className='flex items-center gap-[7px]'>
              <Label htmlFor='mapping-reasoning'>思考等级</Label>
              {/* 问号走组件库 Tooltip（旧的 data-tip + tooltip.js 是同一目标的更简陋版本） */}
              <Tooltip>
                <TooltipTrigger render={<span className='tip-q' tabIndex={0} aria-label='思考等级的注入规则' />}>?</TooltipTrigger>
                <TooltipContent>{REASONING_TIP}</TooltipContent>
              </Tooltip>
            </div>
            <Select value={reasoning.select} onValueChange={next => {
              const value = String(next)
              setReasoning(prev => ({ ...prev, select: value }))
            }}>
              {/* 改等级形态没别的可填，把焦点直接放在等级下拉上（旧实现是 setTimeout 里 focus） */}
              <SelectTrigger id='mapping-reasoning' className='w-full' autoFocus={editing}>
                <SelectValue>{reasoning.select === CUSTOM_LEVEL
                  ? '自定义等级…'
                  : (reasoning.select || '不覆盖')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value=''>不覆盖</SelectItem>
                {candidates.map(candidate => (
                  <SelectItem key={candidate} value={candidate}>{candidate}</SelectItem>
                ))}
                <SelectItem value={CUSTOM_LEVEL}>自定义等级…</SelectItem>
              </SelectContent>
            </Select>
            {/* 自定义输入框只在「自定义等级」被选中时露出（条件渲染而不是 hidden：组件库的
                工具类是分层 !important 的，[hidden] 那条未分层规则压不过它） */}
            {showCustomLevel ? (
              <Input id='mapping-reasoning-custom' maxLength={32} autoFocus
                placeholder='自定义等级（例如 custom-high）' autoComplete='off'
                disabled={saving} value={reasoning.custom}
                onChange={event => setReasoning(prev => ({ ...prev, custom: event.currentTarget.value }))}
                onKeyDown={onEnter} />
            ) : null}
          </div>
          <p className='text-xs leading-[1.65] text-subtle'>
            对外名可自由命名，允许与上游模型 ID 同名（同名时该上游的原生路由优先，映射作兜底）；
            支持字母、数字与 <code>- _ . / :</code>。同一对外名可在多个提供商各添加一条：
            下游用同一个名字请求，网关按账号优先级主备切换，失败自动落到下一个提供商。
          </p>
          {/* 状态行：高度固定，出现错误时弹窗不跳高 */}
          <div className='min-h-[18px] text-xs text-subtle'>{status}</div>
        </DialogBody>
        <DialogFooter>
          <div className='mr-auto' />
          <Button variant='outline' onClick={onClose}>取消</Button>
          <Button variant='default' disabled={saving} onClick={() => void save()}>
            {editing ? '保存等级' : '保存映射'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── 添加模型弹窗 ───────────────────────────── */

/**
 * 「＋ 添加模型」：手动登记一个「上游目录里没有、但实际能路由」的模型（灰度中的新模型、按
 * 账号下发却没进目录的模型）。登记后它**真的进入该家清单**（后端在 `catalog::manifest_for`
 * 里拼接），于是表格里出现这一行、`/v1/models` 会广告它、路由与转发也都认它 —— 与内置模型
 * 相比只少几个能力位元数据（用户无从知道那些值，编一个等于对下游撒谎）。
 */
function CustomModelDialog({ initial, onClose }: { initial: CustomModelContext; onClose: () => void }) {
  const [provider, setProvider] = React.useState(initial.provider)
  const [id, setId] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  const choices = (() => {
    const options = customProviderOptions()
    if (provider && !options.some(item => item.id === provider)) {
      options.push({ id: provider, label: shared().wbProviders?.labelOf?.(provider) || provider })
    }
    return options
  })()
  // 候选里没有当前值时退回首项（原生 select 赋一个不存在的值也是这个结果）
  const providerValue = choices.some(item => item.id === provider) ? provider : (choices[0]?.id || '')
  const providerLabel = choices.find(item => item.id === providerValue)?.label || providerValue || '(未选)'

  async function save(): Promise<void> {
    if (saving) return
    const value = id.trim()
    if (!providerValue) { setStatus('请选择提供商'); return }
    if (!value) { setStatus('请填写上游模型 ID'); return }
    setSaving(true)
    setStatus('保存中…')
    try {
      const next = await writeAddModel(providerValue, value)
      accept(next)
      setSaving(false)
      onClose()
      const label = choices.find(item => item.id === providerValue)?.label || providerValue
      if (customSource.isCustom(currentProvider())) {
        // 自定义家的清单就是用户自己的登记表，登记了必然出现在表里，所以只有一句成功提示
        toast(`✅ 已登记模型 ${value}（${label}）`)
      } else {
        // 内置家：登记成功但表格里看不到这一行时，必须说清为什么 —— 表格只列「当前有可用
        // 登录态」的家，给一个还没加账号的家登记模型不会立刻出现。不说的话用户会以为没保存成功
        const view = next as ManageView | null
        const visible = Array.isArray(view?.models)
          && view.models.some(item => item.id === value && (item.provider || '') === providerValue)
        if (visible) toast(`✅ 已登记自定义模型 ${value}（${label}）`)
        else toast(`✅ 已登记 ${value}（${label}），但该提供商还没有可用账号，这一行要加上账号后才会显示`, 'err')
      }
    } catch (error) {
      setStatus(`保存失败：${errorMessage(error)}`)
      setSaving(false)
    }
  }

  const onEnter = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void save()
  }

  return (
    <Dialog open onOpenChange={(next, eventDetails) => {
      // 保存中不许关：关掉会让「到底存没存进去」变成未知状态
      if (next) return
      if (saving) { eventDetails.cancel(); return }
      onClose()
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加自定义模型</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='custom-model-provider'>提供商</Label>
            <Select value={providerValue} disabled={initial.locked}
              onValueChange={next => setProvider(String(next))}>
              <SelectTrigger id='custom-model-provider' className='w-full'>
                <SelectValue>{providerLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {choices.map(item => (
                  <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='custom-model-id'>上游模型 ID</Label>
            <Input id='custom-model-id' maxLength={128} placeholder='例如 gpt-5.5-preview'
              autoComplete='off' spellCheck={false} autoFocus value={id}
              onChange={event => setId(event.currentTarget.value)} onKeyDown={onEnter} />
          </div>
          <div className='rounded-md border border-border bg-surface-inset px-3 py-2.5 font-mono text-[12px] text-subtle'>
            在 <b className='text-primary-fg'>{providerLabel}</b> 上登记上游模型{' '}
            <b className='text-primary-fg'>{id.trim() || '<上游模型 ID>'}</b>（登记后即可用这个名字请求）
          </div>
          <p className='text-xs leading-[1.65] text-subtle'>
            填上游真正认识的那个模型 ID（不是给下游用的名字）。登记后它会进入该家的模型清单：
            表格里出现这一行、<code>/v1/models</code> 会广告它、请求它也会被转发到这家。
            支持字母、数字与 <code>- _ . / :</code>。
          </p>
          <p className='text-xs leading-[1.65] text-subtle'>
            「来源」列会标成<b>手动</b>，与远程目录 / 内置清单区分开。删除自定义模型是
            <b>直接移除</b>这条登记（不像内置模型那样只是隐藏），因为它的存在完全由这次登记决定。
          </p>
          <div className='min-h-[18px] text-xs text-subtle'>{status}</div>
        </DialogBody>
        <DialogFooter>
          <div className='mr-auto' />
          <Button variant='outline' onClick={onClose}>取消</Button>
          <Button variant='default' disabled={saving} onClick={() => void save()}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── 挂载：接管 index.html 里既有的页面区块 ─────── */

const PAGE_SELECTOR = '.page[data-page="gateway"]'

let root: ReturnType<typeof createRoot> | null = null

/**
 * 把 React root 直接建在 `.page[data-page="gateway"]` 上（不套宿主 div：页面 CSS 用
 * `.page[data-page="gateway"] .panel` 这组直接子选择器分配高度，中间插一层会打断它）。
 *
 * 先清掉骨架里的静态子节点（那张 `.panel`）：下面的 JSX 会按同样的类名重新渲染它，留着会与
 * React 的接管打架。createRoot 不替我们清容器，所以手动 replaceChildren()；容器自身的
 * class / data-page 由页面管，别动。
 */
function mount(): void {
  if (root) return
  const section = document.querySelector<HTMLElement>(PAGE_SELECTOR)
  if (!section) return
  section.replaceChildren()
  root = createRoot(section)
  root.render(<ModelsPage />)
}

// 脚本排在页面骨架之后（index.html 里 islands/ui.js 在各 section 之后），正常直接挂；
// 万一将来被挪到前面，退化成等 DOM 解析完再挂。
if (document.querySelector(PAGE_SELECTOR)) mount()
else document.addEventListener('DOMContentLoaded', mount, { once: true })
