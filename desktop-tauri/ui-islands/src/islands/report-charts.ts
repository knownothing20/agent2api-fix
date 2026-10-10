/* Agent2API · 报表页的纯计算层（读数口径 / 单位 / 四张手写 SVG 的几何） */

/**
 * 为什么单独一个 .ts：岛目录里的 *.tsx 会被 index.tsx 的 glob 当成岛自动加载，
 * 而这里只是纯函数（不注册 window、不建 React root、不碰 DOM）。计算与视图分开，
 * 几何公式可以逐条对着旧 ui/report.js 核对，视图那边只负责把这里算出来的坐标铺进 JSX。
 *
 * 四张图都是手写 SVG（项目没有图表库，也不为一个页面引依赖）：
 *   · 折线 / 柱状图按**像素坐标**画：先量容器宽度再算坐标，文字与刻度线因此不会被
 *     拉变形；宽度变化由 report-page.tsx 的 ResizeObserver 量好传进来重算。
 *   · 热力图格子边长固定、只让列数随宽度自适应，观感与 GitHub 贡献图一致。
 *   · 用量环形图尺寸固定、不随窗口变：它旁边挂着图例列表，两者并排占满卡片，
 *     尺寸一动反而会让右侧那列读数跟着跳。
 * 这里只回答「给定数据与容器宽度 → 画在哪」，不知道容器是谁、什么时候重算。
 */

/* ─── 数据形状（后端 /api/stats/summary，字段都可缺省） ─── */

export type StatsDay = { date?: string; tokens?: number; requests?: number }
export type StatsHour = {
  hour?: string; rate?: number; totalTokens?: number; hitTokens?: number; inputTokens?: number
}
/** 排行 / 环形图共用的一条：模型维度用 model 当身份，提供商与账号维度用 id */
export type StatsGroup = {
  id?: string; label?: string; model?: string
  requests?: number; success?: number; totalTokens?: number; tokens?: number
}
export type StatsOverview = {
  requests?: number; successful?: number; tokens?: number; activeDays?: number; streak?: number
  topModel?: { model?: string; tokens?: number; percentage?: number } | null
}
export type CacheRateWindow = { inputTokens?: number; hitTokens?: number; rate?: number }
export type StatsSummary = {
  /** 按天 × 模型 / 按天 × 账号的用量序列（后端 trendByModel / trendByAccount） */
  trendByModel?: StatsUsagePoint[]
  trendByAccount?: StatsUsagePoint[]
  range?: string; startDate?: string; endDate?: string
  overview?: StatsOverview
  providers?: StatsGroup[]
  accounts?: StatsGroup[]
  models?: StatsGroup[]
  heatmap?: StatsDay[]
  cacheRates?: Record<string, CacheRateWindow>
  cacheTrend24h?: StatsHour[]
  dailyTrend?: StatsDay[]
}

/* ─── 时间范围（档位与后端白名单逐字一致） ─── */

/** 合法的时间范围：与后端 /api/stats/summary 的白名单逐字一致（非法值后端返回 400） */
export const RANGES: readonly string[] = ['today', '7', '30', 'month', 'all']
export const DEFAULT_RANGE = '7'
/** 持久化键：沿用项目既有的 workbuddy-desktop-* 前缀（主题 / 页码 / 日志开关是同一套） */
export const RANGE_KEY = 'workbuddy-desktop-report-range'
export const RANGE_LABEL: Record<string, string> = {
  today: '今天', 7: '近 7 天', 30: '近 30 天', month: '本月', all: '全部',
}
/**
 * 分段控件上的短标签。与 RANGE_LABEL 是两套，别合并：那边是概览小格的说明文字
 * （「近 7 天」），控件里位置窄，用更短的（「7 天」）。
 */
export const RANGE_OPTION_LABEL: Record<string, string> = {
  today: '今天', 7: '7 天', 30: '30 天', month: '本月', all: '全部',
}

/** 只有明确存过合法值才采纳；无值 / 读取抛错 / 值被改坏都回落默认的 7 天 */
export function readRange(): string {
  try {
    const saved = localStorage.getItem(RANGE_KEY)
    return saved !== null && RANGES.includes(saved) ? saved : DEFAULT_RANGE
  } catch {
    return DEFAULT_RANGE
  }
}

/** 热力图与折线图共用的星期行标签：只标周一 / 三 / 五，七行全写会糊成一片 */
export const WEEKDAY_ROWS: readonly (readonly [number, string])[] = [[0, '一'], [2, '三'], [4, '五']]

/**
 * 超过这个条数就不再给热区挂 data-tip，改用 SVG 自带的 <title>。
 *
 * 这道闸是必要的：data-tip 由 tooltip.js 自动增强，每个元素都会拿到六个事件监听 + 一个
 * 专属 ResizeObserver。固定开销已经不小 —— 热力图 365 格 + 折线 24 格 —— 柱状图再叠几百
 * 上千个就会明显拖慢切页。阈值 400：加起来仍在一千以内；而 backend 的按天序列理论上能到
 * 4000 天（手改保留期才会出现），那种极端区间必须挡在外面。
 */
export const TIP_LIMIT = 400

/* ─── 读数口径 ─────────────────────────────── */

/** 计数：千分位。请求数天然是整数，缩写反而看不出量级差 */
export function formatInt(value: unknown): string {
  return (Number(value) || 0).toLocaleString('zh-CN')
}

/** units.js 的公开面（本文件只读它的两个格式化函数，不碰开关本身） */
type UnitsBridge = {
  formatTokens?: (value: unknown) => string
  formatAxis?: (value: number, max: number) => string
}

/** 局部窄类型 + 转型，而不是 declare global：wbUnits 是多页共享的桥，各岛各 declare
 *  一份会因同名属性类型不一致直接报 TS2717（与 wbApp / workbuddyDesktop 同一处理）。 */
function units(): UnitsBridge {
  return (window as unknown as { wbUnits?: UnitsBridge }).wbUnits || {}
}

/**
 * Token 读数与纵轴刻度都交给 units.js：中文量级（亿 / 万）与英文缩写（M / k）的
 * 差别、以及设置页那个开关的读写全在那边一处，这里只管「用哪个函数画在哪」。
 * 本页十来处读数（概览、tooltip、柱顶标注）都走它 —— 口径一致，用户拨一下开关
 * 就是整页一起变。
 *
 * 刻意在调用时读 window.wbUnits 而不是模块顶层解构：units.js 排在岛之前加载是
 * 现状，但拿不到时也只是退回裸数字，不必为此把整个模块搞成加载顺序的囚徒。
 */
export function formatTokens(value: unknown): string {
  const api = units()
  return api.formatTokens ? api.formatTokens(value) : String(Number(value) || 0)
}

export function axisText(value: number, max: number): string {
  const api = units()
  return api.formatAxis ? api.formatAxis(value, max) : String(value)
}

/** 命中率保留一位小数：整数百分比看不出 87.5% 与 87.9% 的差别 */
export function formatPercent(rate: unknown): string {
  return `${((Number(rate) || 0) * 100).toFixed(1)}%`
}

/** 坐标保留一位小数即可，串更短、与旧实现的输出也逐字一致 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 标注文字宽度的粗估（中日韩字符占满格、数字与 % 只有半格）。
 * 这是给「标注互相避让」用的近似值，不必精确 —— 差几像素只会让一两处标注多留一点余量。
 */
export function textWidth(text: string): number {
  return [...text].reduce((sum, ch) => sum + (/[\u2e80-\u9fff]/.test(ch) ? 9.7 : 5.4), 0)
}

/** `YYYY-MM-DD` → 本地零点。不用 new Date('2026-09-17')：那种写法按 UTC 解析，
 *  在东八区会得到前一天 08:00，星期几就跟着错一天。 */
export function parseDay(key: unknown): Date {
  const [y, m, d] = String(key || '').split('-').map(Number)
  return new Date(y || 1970, (m || 1) - 1, d || 1)
}

/** 日期写成人话：9月17日 周三（tooltip 用） */
export function dayLabel(key: unknown): string {
  const date = parseDay(key)
  return `${date.getMonth() + 1}月${date.getDate()}日 周${'日一二三四五六'[date.getDay()]}`
}

/** 紧凑日期 `9/28`：短区间要**每天都标**，而完整标签（「9月28日 周一」）挤不下 ——
 *  7 天 × 8 个字在 800px 宽的图上必然重叠，只能隔天标，于是「近 7 天」看着像 4 天
 *  （2026-10-04 用户就是这么问的）。 */
export function shortDayLabel(key: unknown): string {
  const date = parseDay(key)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 本地整点键 `YYYY-MM-DDTHH` → `15:00`（只取时钟位，时区口径由后端定死） */
export function hourText(key: unknown): string {
  const time = String(key || '').slice(11, 13)
  return time ? `${time}:00` : '—'
}

/* ─── 纵轴刻度 ─────────────────────────────── */

/**
 * 每格步长取「好读」的档位（1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 × 10^n）。
 *
 * ── 为什么不是先定上限再四等分 ───────────────────────────────
 * 对峰值直接取 niceCeil（1/2/5×10^n）再四等分，刻度常落在「1.25亿」这类值上
 * （2.16亿的峰值 → 上限 5亿 → 每格 1.25亿）。刻度是拿来读的，遇到 1.25 亿还得在
 * 心里换算一遍才敢用。改成先定每格再乘 4 段：峰值 2.16亿 时每格 6000万、上限 2.4亿，
 * 五个刻度就是 0 / 6000万 / 1.2亿 / 1.8亿 / 2.4亿，每一个都是能一眼读出来的数。
 *
 * 档位里带上 1.5 / 2.5 / 3 / 6 / 8 而不是只留 1/2/5：只留三档时，峰值稍高于 2×10^n
 * 就会跳到 5×10^n，柱子高度从 90% 掉到 40%，白白浪费半张图。
 */
const STEP_LADDER = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

function niceStep(value: number): number {
  if (!(value > 0)) return 1
  const pow = 10 ** Math.floor(Math.log10(value))
  const norm = value / pow
  const step = STEP_LADDER.find(item => item >= norm - 1e-9) ?? 10
  return step * pow
}

/** 纵轴上限 = 好读的每格步长 × 4 段（刻度线固定 5 条，见各图表的网格循环） */
export function axisMax(peak: number): number {
  return niceStep(peak / 4) * 4
}

/* ─── 板块一：统计概览 ────────────────────── */

export type OverviewCell = { key: string; label: string; value: string; sub: string; mono: boolean }

export function overviewCells(overview: StatsOverview | undefined, range: string, days: number): OverviewCell[] {
  const data = overview || {}
  const top = data.topModel
  const requests = Number(data.requests) || 0
  const successful = Number(data.successful) || 0
  // 请求数为 0 时成功率没有意义（0/0），给破折号而不是 0%
  const successRate = requests ? `${((successful / requests) * 100).toFixed(1)}%` : '—'

  const cells: OverviewCell[] = [
    { key: 'requests', label: '总请求数', value: formatInt(requests), sub: RANGE_LABEL[range] || '', mono: false },
    { key: 'successful', label: '成功请求数', value: formatInt(successful), sub: `成功率 ${successRate}`, mono: false },
    { key: 'tokens', label: '总 Token', value: formatTokens(data.tokens), sub: '输入 + 输出', mono: false },
    // 「活跃天数 / 当前连续天数」两块按用户要求去掉（2026-10-04：「很多其实不用知道，
    // 把不怎么重要的放后面或取消」）。它们回答的是「我坚持用了多久」——与「用了多少」
    // 不是同一个问题，而首屏每一格都在挤同一行的宽度。数据仍由后端返回
    // （`overview.activeDays` / `overview.streak`），要恢复只是把这两行加回来。
  ]
  cells.push(top
    ? {
      key: 'topModel', label: 'Top 模型', value: String(top.model ?? ''),
      sub: `${formatTokens(top.tokens)} tokens · 占 ${formatPercent(top.percentage)}`, mono: true,
    }
    : { key: 'topModel', label: 'Top 模型', value: '—', sub: '所选范围内还没有模型用量', mono: false })
  return cells
}

/* ─── 板块二：Top 提供商 / Top 账号排行 ────── */

/**
 * 两张卡片（并排）共用同一套渲染：都是「一行一个主体 + 用量条 + Token 用量」，
 * 差别只在数据来源、名字怎么取（账号行前面还多一枚提供商徽章，由视图层加）。
 *
 * ── 为什么这一维只看 Token（照旧，别改）──────────────────────
 * 这一块存在的意义是回答「**用量**花在谁身上」—— 用量就是 Token，请求数是过程量
 * （一条 3 次重试的失败请求也会 +3 次请求数，却一个 Token 都不消耗）。所以排序依据、
 * 条宽基准、格内读数、小标题、tooltip 全部统一到 Token 这一条口径上，成功率也一并
 * 去掉：它不是用量。成功率与请求数没有消失 —— 概览那张卡片里有精确值。
 *
 * 数据来自 summary.providers / summary.accounts（`[{id,label,requests,totalTokens}]`）。
 * 契约里没有这个字段（undefined）就整块隐藏：那是「这份后端还没有这一维」，与「字段在
 * 但为空数组」（这段时间一条明细都没记下这一维）是两件事，前者是版本落后。
 */
export type RankRowView = {
  key: string; id: string; name: string
  /** 「名字（id）」：整行的气泡说明与名字列的原生 title 共用同一串 */
  full: string; tip: string
  tokensText: string; percentText: string; barWidth: string
}

/** `null` = 契约里没有这一维（整块隐藏）；空数组 = 这一维没有数据（给空态文案） */
export function rankRows(list: StatsGroup[] | undefined): RankRowView[] | null {
  if (!Array.isArray(list)) return null

  const rows = list
    .map(item => ({
      id: String(item?.id ?? '').trim(),
      // label 缺省用 id 兜底；两者都空的那一组是后端的「未知」
      label: String(item?.label ?? '').trim(),
      // 后端字段名是 totalTokens（account 维度同形）；tokens 是兼容旧版本/别处形态的兜底读法
      tokens: Number(item?.totalTokens ?? item?.tokens) || 0,
    }))
    // 全零的组不参与：它们只可能来自手改过的数据，画出来是一条永远为 0 的行。
    // 判据只看 tokens —— 与排序口径同一条，才不会出现「因为请求数 >0 被保留、
    // 却按 0 Token 排在最后」的怪行
    .filter(item => item.tokens > 0)

  if (!rows.length) return []

  const total = rows.reduce((sum, item) => sum + item.tokens, 0)
  // 总量为 0 时不给百分比：0/0 没有意义（上面的 filter 已把全零组滤掉，这里只是兜底）
  const share = (count: number) => (total ? (count / total) * 100 : 0)

  // 按 Token 用量降序排序后全量渲染：不再把溢出行并进「其它」，占比的分母仍是对该
  // 维度全量求和，每行的百分比加起来始终是 100%
  return [...rows].sort((left, right) => right.tokens - left.tokens).map((item, index) => {
    const percent = share(item.tokens)
    const text = formatTokens(item.tokens)
    const name = item.label || item.id || '未知'
    // 账号名可能重复（两家都能叫「默认」），provider 的 id 是注册表里的短标识
    // （workbuddy / qoder）—— 两者都靠 id 认身份，气泡里带上它
    const full = item.id ? `${name}（${item.id}）` : name
    return {
      // key 带上下标：id 与名字理论上都可能重名（手改过的聚合行），React 的 key 必须唯一
      key: `${index}-${item.id || name}`,
      id: item.id,
      name,
      full,
      // 气泡只讲用量：读数 + 占比，与格里看到的两列同源（不给成功率，见上）
      tip: `${full}：${text} tokens · 占 ${percent.toFixed(1)}%`,
      tokensText: text,
      percentText: `${percent.toFixed(1)}%`,
      // 条宽用百分比：容器宽度变化时条跟着伸缩，不必像 SVG 那样量宽度重绘
      barWidth: `${percent.toFixed(1)}%`,
    }
  })
}

/** 卡片头的小标题读数：**Token 总量**（不再是「N 次请求」），与行内读数同一口径，
 *  于是「各行之和小标题」这条对账关系在界面上随时看得出来。按原始列表求和（与旧实现一致）。 */
export function rankTotalText(list: StatsGroup[]): string {
  return `${formatTokens(list.reduce(
    (sum, item) => sum + (Number(item?.totalTokens ?? item?.tokens) || 0), 0))} tokens`
}

/* ─── 板块三：用量环形图（模型 / 提供商）──── */

/**
 * 分色板：与 OmniProxy 的 `MODEL_COLORS` 逐字一致。
 *
 * 前 6 色是优先色（红 / 黄 / 绿 / 蓝 / 靛 / 青），按用量排名分配 —— 用量最大的那段
 * 拿红色，一眼就能找到「谁是大头」。后 10 色为补充色，已逐一校验过与优先色及彼此在
 * 色相（<22°）与明度（<17）上都不接近，两套主题下都能分辨。条目数超过色板容量（16）
 * 时从头循环复用。
 */
export const SLICE_COLORS: readonly string[] = [
  '#f73b00', '#f7bb07', '#4aaa4d', '#1872cb', '#3444a3', '#13c2c2',
  '#722ed1', '#eb2f96', '#a0d911', '#34d399', '#d946ef', '#ff85c0',
  '#b37feb', '#9d174d', '#ffa39e', '#69b1ff',
]

/**
 * 环形图几何：内半径 62%、外半径 88%（与 OmniProxy 的 innerRadius/outerRadius 同值）。
 * `padAngle` 是扇区间隙的**上限**（度）—— 实际取值还会被每段自身角度夹一次。
 */
export const DONUT = { size: 220, inner: 0.62, outer: 0.88, padAngle: 2 }

/**
 * 环形图扇区的 SVG 路径。
 *
 * 从 12 点方向顺时针画（SVG 的 0° 在 3 点方向，所以起点减 90°）—— 与 OmniProxy 的
 * recharts 默认起始角一致，最大的那段落在右上，阅读顺序与右侧图例从上到下相同。
 *
 * `padAngle` 换算成弧度后从两端各让出半个 —— recharts 的 `paddingAngle` 就是这个语义。
 * 间隙让相邻扇区不粘在一起，颜色接近的两段（比如两种蓝）也能靠这道缝分开。
 *
 * 整圆（单一段占满 100%）要特判：起终点重合时 SVG 的 A 命令画不出圆，会退化成一条
 * 零长路径、整张图看起来是空的。用两段半圆拼出整圆。
 *
 * ── 整圆为什么必须配 evenodd 填充 ────────────────────────────
 * 默认的 nonzero 规则按子路径的**绕向**累加：内外两圈都顺时针时绕数都是 1，内圈不会
 * 挖空，整圆会渲染成一个**实心圆盘** —— 中心读数直接压在色块上。多段那条路径没有这个
 * 问题（内外绕向天然相反），所以只有整圆这个分支需要显式指定 evenodd（由调用方挂）。
 */
export function donutSlicePath(
  cx: number, cy: number, outer: number, inner: number, startAngle: number, endAngle: number,
): string {
  const rad = (angle: number) => ((angle - 90) * Math.PI) / 180
  const point = (radius: number, angle: number): [number, number] => [
    round1(cx + radius * Math.cos(rad(angle))),
    round1(cy + radius * Math.sin(rad(angle))),
  ]
  const sweep = endAngle - startAngle
  if (sweep >= 359.999) {
    // 整圆：两段半圆（各自 180°），避免起终点重合导致 A 命令退化
    const [ox1, oy1] = point(outer, 0)
    const [ox2, oy2] = point(outer, 180)
    const [ix1, iy1] = point(inner, 0)
    const [ix2, iy2] = point(inner, 180)
    return `M ${ox1} ${oy1} A ${outer} ${outer} 0 1 1 ${ox2} ${oy2}`
      + ` A ${outer} ${outer} 0 1 1 ${ox1} ${oy1} Z`
      + ` M ${ix1} ${iy1} A ${inner} ${inner} 0 1 0 ${ix2} ${iy2}`
      + ` A ${inner} ${inner} 0 1 0 ${ix1} ${iy1} Z`
  }
  const [ox1, oy1] = point(outer, startAngle)
  const [ox2, oy2] = point(outer, endAngle)
  const [ix2, iy2] = point(inner, endAngle)
  const [ix1, iy1] = point(inner, startAngle)
  // largeArc 只在超过半圆时置 1；sweep 恒为 1（顺时针）
  const large = sweep > 180 ? 1 : 0
  return `M ${ox1} ${oy1} A ${outer} ${outer} 0 ${large} 1 ${ox2} ${oy2}`
    + ` L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`
}

export type DonutSliceView = {
  key: string; d: string; fill: string
  /** 整圆必须 evenodd（见 donutSlicePath），多段路径挂不挂都一样 */
  evenOdd: boolean
  /** 扇区内的百分比标签：只在 ≥3% 时给（再小就叠成一团） */
  label: { x: number; y: number; text: string } | null
  tip: string
}
export type DonutLegendView = {
  key: string; fill: string; name: string; tokensText: string; percentText: string; tip: string
}
export type DonutView = { size: number; slices: DonutSliceView[]; legend: DonutLegendView[]; totalText: string }

/**
 * 环形图 + 右侧图例列表（模型用量 / 提供商用量的共用实现）。`null` = 这一维没数据。
 *
 * 数据形状（`[{label, totalTokens, requests}]`）：模型与提供商两维同形，身份字段名不同
 * （模型是 `model`、提供商是 `id`），按「label → model → id」依次兜底。
 *
 * 图例带上 Token 与百分比：扇区角度只表达「相对占比」，看不出绝对量级 —— 而「这段是
 * 1.2 亿还是 1200 万」正是用户要问的。中心读数是总量：把各扇区的共同分母摆在最显眼处，
 * 右侧每段的百分比立刻有了参照。
 */
export function donutView(list: StatsGroup[] | undefined, unknownLabel: string): DonutView | null {
  const rows = (Array.isArray(list) ? list : [])
    .map(item => {
      const label = String(item?.label ?? item?.model ?? item?.id ?? '').trim()
      return {
        label: label || unknownLabel,
        tokens: Number(item?.totalTokens ?? item?.tokens) || 0,
        requests: Number(item?.requests) || 0,
      }
    })
    // 全零的组不画：只可能来自手改过的数据，扇区角为 0 什么也看不见
    .filter(item => item.tokens > 0)

  if (!rows.length) return null
  const total = rows.reduce((sum, item) => sum + item.tokens, 0)
  if (!total) return null

  const { size, inner, outer, padAngle } = DONUT
  const cx = size / 2
  const cy = size / 2
  const outerR = (size / 2) * outer
  const innerR = (size / 2) * inner

  let angle = 0
  const slices: DonutSliceView[] = []
  const legend: DonutLegendView[] = []

  rows.forEach((item, index) => {
    const percent = item.tokens / total
    const sweep = percent * 360
    // 间隙从两端各让出半个，但**不能超过本段自身的四分之一**：色板之外的段（模型很多时）
    // 单段可能只有 1° 多，固定 2° 的间隙会把整段吃成负角度、直接从环上消失，而右侧图例
    // 还列着它 —— 图例与图形对不上是最难查的一类错。夹到 sweep/4 后每段至少还剩一半可见。
    const gap = rows.length > 1 ? Math.min(padAngle / 2, sweep / 4) : 0
    const start = angle + gap
    const end = angle + sweep - gap
    angle += sweep
    const fill = SLICE_COLORS[index % SLICE_COLORS.length]
    // 扇区内的百分比标签：只在 ≥3% 时画（再小就叠成一团），白色加描边保证任意底色上都
    // 读得清 —— 与 OmniProxy 的 renderPieLabel 同一阈值与手法
    let label: DonutSliceView['label'] = null
    if (percent >= 0.03) {
      const mid = (start + end) / 2
      const radius = innerR + (outerR - innerR) * 0.6
      const rad = ((mid - 90) * Math.PI) / 180
      label = {
        x: round1(cx + radius * Math.cos(rad)),
        y: round1(cy + radius * Math.sin(rad)),
        text: `${Math.round(percent * 100)}%`,
      }
    }
    // end > start 兜住「四舍五入后两者相等」的极端情形（千段以上才会出现），此时这一段
    // 确实画不出来，但图例仍在 —— 悬停图例行照样能读到它的数值
    if (end > start) {
      slices.push({
        // key 带上下标：标签理论上可能重名（后端手改过的聚合行），React 的 key 必须唯一
        key: `${index}-${item.label}`,
        d: donutSlicePath(cx, cy, outerR, innerR, start, end),
        fill,
        evenOdd: sweep >= 359.999,
        label,
        tip: `${item.label} · ${formatTokens(item.tokens)} tokens · ${formatPercent(percent)}`,
      })
    }
    legend.push({
      key: `${index}-${item.label}`,
      fill,
      name: item.label,
      tokensText: formatTokens(item.tokens),
      percentText: formatPercent(percent),
      tip: `${item.label} · ${formatTokens(item.tokens)} tokens · ${formatInt(item.requests)} 次请求 · ${formatPercent(percent)}`,
    })
  })

  return { size, slices, legend, totalText: formatTokens(total) }
}

/* ─── 板块四：热力图 ──────────────────────── */

/**
 * 热力图分档：0，以及按**本次窗口内的 Token 峰值**等分出的四档。
 *
 * ── 为什么不再用固定阈值（旧 BUG）────────────────────────────
 * 原先写死 `[0, 2, 5, 10, ∞]`（按请求次数），理由写在旧注释里：「本工具的日请求量普遍
 * 是个位数」。这个前提在实际使用中不成立 —— 单日几千次请求、几亿 Token 是常态，于是
 * **所有有请求的日子全部落进最深一档**，365 个格子只剩「空槽」与「同一个深蓝」两种
 * 颜色，热力图彻底失去信息量。分位数（按排名切）能自适应，但会把「当天只有 1 次请求」
 * 也涂成最深一档 —— 颜色就不再表示「多少」，只剩「相对排名」。所以保留「按绝对量级
 * 分档」的思路，只把量级本身改成按窗口峰值现算。
 *
 * ── 步长为什么向下取整 ───────────────────────────────────────
 * 直接 `peak / 4` 会切出「3.3亿」这种阈值；向上取整到好读值又会让步长超过 `peak / 4`，
 * 把本该分开的两天并进同一档（实测「4.6亿 / 7亿」在向上取整下双双落到第 2 档，正是要
 * 修的那个毛病）。向下取整到 1 / 1.25 / … / 8 × 10^n 这一串好读值，则同时满足两点：
 * 阈值是整数，且四档比等分切得更细。
 */
const HEAT_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

/** 向下取整到 `HEAT_STEPS × 10^n` 中不超过 `value` 的最大值 */
function heatStepFloor(value: number): number {
  if (!(value > 0)) return 1
  const pow = 10 ** Math.floor(Math.log10(value))
  const norm = value / pow
  let best = 1
  for (const item of HEAT_STEPS) if (item <= norm + 1e-9) best = item
  return best * pow
}

/** 四档阈值（含 0 与 Infinity，共五项）：0 / step / 2step / 3step / 以上 */
export function heatLevelsFor(peak: unknown): number[] {
  const top = Number(peak) || 0
  // 全窗口零用量：给一组平凡阈值即可，所有格子都会落在第 0 档
  if (top <= 0) return [0, 1, 2, 3, Infinity]
  // 步长下限 1：Token 是整数，`peak/4` 小于 1 时会算出 0.25 这种没意义的阈值
  const step = Math.max(1, heatStepFloor(top / 4))
  return [0, step, step * 2, step * 3, Infinity]
}

/**
 * 每一档的说明文字（图例用）。阈值随窗口峰值变，所以读当次算出的那一份。
 * 档与档之间按「上一档的上限」直接接着写（`3亿–6亿`）而不是 `+1`：判定用的是闭区间
 * `value <= 上限`，Token 又是大整数，逐 1 递增在读数上看不出来，写出来反而把图例撑长。
 */
export function heatLevelText(level: number, thresholds: number[]): string {
  if (level === 0) return '0'
  const lower = thresholds[level - 1]
  const upper = thresholds[level]
  if (!Number.isFinite(upper)) return `>${formatTokens(lower)}`
  return lower === 0 ? `≤${formatTokens(upper)}` : `${formatTokens(lower)}–${formatTokens(upper)}`
}

/**
 * 从一次报表数据里算出本窗口的阈值 —— 格子着色与图例文字**唯一**的来源。两处各算一次
 * 是不行的：刷新间隔只有 1 秒，图例与格子很容易停在两批数据上，那时图例的数字与实际
 * 着色就对不上了。
 */
export function heatThresholdsOf(days: StatsDay[] | undefined): number[] {
  const list = Array.isArray(days) ? days : []
  return heatLevelsFor(list.reduce((max, day) => Math.max(max, Number(day?.tokens) || 0), 0))
}

export type HeatmapView = {
  width: number
  height: number
  months: { key: string; x: number; text: string }[]
  weekdays: { key: string; x: number; y: number; text: string }[]
  cells: { key: string; level: number; x: number; y: number; size: number; tip: string }[]
}

/**
 * GitHub 贡献图布局：53 列（周）× 7 行（星期）。首列用空格补齐到周一、末列不满也留空。
 *
 * ── 为什么要横向铺满容器 ─────────────────────────────────────
 * 一年固定 53 列，格子边长若按「下限 7px、上限 13px」夹取，在常见窗口宽度（内容区
 * 1000px 上下）里算出来会停在下限附近，整块图只占容器三分之二宽、右边空一大截。
 * 这里改成**按容器宽度反推格子边长**（夹取区间放宽到 7–26px）：算出来的边长让 53 列
 * 恰好填满可用宽度。夹取区间仍然必要：窗口极窄时不能让格子小到看不清（交给 .heat-wrap
 * 横向滚动），窗口极宽时也不能让格子大到一格占满屏幕（此时整块居中留白）。
 */
export function heatmapView(days: StatsDay[] | undefined, boxWidth: number): HeatmapView | null {
  const list = Array.isArray(days) ? days : []
  if (!list.length) return null

  const pad = (parseDay(list[0].date).getDay() + 6) % 7   // 周一为 0：一周从周一起算
  const cells: (StatsDay | null)[] = new Array(pad).fill(null).concat(list)
  const cols = Math.ceil(cells.length / 7)

  const gap = 3
  const labelW = 20    // 左侧星期标签
  // 顶部要给月份标签留位置；格子边长变大时标签也跟着长，所以这里按算出来的边长放大留白
  const available = boxWidth - labelW
  const fit = Math.floor((available - gap * (cols - 1)) / cols)
  const size = Math.max(7, Math.min(26, fit))
  const topH = size + 3
  // 夹取后（窗口极宽 / 极窄）图形不再等于容器宽度，改为居中：两边留白对称
  const step = size + gap
  const gridW = labelW + cols * step - gap
  const offsetX = Math.max(0, Math.round((boxWidth - gridW) / 2))
  const height = topH + 7 * step - gap + 2
  const width = Math.max(gridW, Math.round(boxWidth))

  // 分档口径是 **Token 用量**（不再是请求次数）：请求数是过程量，一条 3 次重试的失败请求
  // 也会 +3 次却一个 Token 都不消耗，而这一整页的其余读数全部以 Token 为准 —— 热力图跟着走，
  // 用户对着同一天的格子和柱子看到的就是同一个量。阈值由 heatThresholdsOf 统一给出。
  const thresholds = heatThresholdsOf(list)
  const levelOf = (tokens: unknown) => thresholds.findIndex(limit => Number(tokens) <= limit)

  const cellsOut: HeatmapView['cells'] = []
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < 7; row += 1) {
      const day = cells[col * 7 + row]
      if (!day) continue
      const requests = Number(day.requests) || 0
      const tokens = Number(day.tokens) || 0
      // 「有没有用过」看**请求数**，不看 Token：全部请求都失败的日子请求数大于 0 而 Token
      // 为 0，按 Token 判会把它说成「无请求」（明明试过了）。Token 只是着色依据与读数之一。
      const tip = requests
        ? `${dayLabel(day.date)} · ${formatTokens(tokens)} tokens · ${formatInt(requests)} 次请求`
        : `${dayLabel(day.date)} · 无请求`
      cellsOut.push({
        key: String(day.date),
        level: levelOf(tokens),
        x: round1(offsetX + labelW + col * step),
        y: round1(topH + row * step),
        size,
        tip,
      })
    }
  }

  const weekdays = WEEKDAY_ROWS.map(([row, text]) => ({
    key: text,
    x: offsetX + labelW - 6,
    y: round1(topH + row * step + size / 2),
    text,
  }))

  // 月份标签落在「该列最早一天所属月份」与上一列不同的那一列，与 GitHub 同一手法；
  // 两列挨太近（<3 列）时这次不写，但仍记下月份，避免标签叠字
  const months: HeatmapView['months'] = []
  let lastMonth = -1
  let lastLabelCol = -9
  for (let col = 0; col < cols; col += 1) {
    const head = cells.slice(col * 7, col * 7 + 7).find(Boolean)
    if (!head) continue
    const month = parseDay(head.date).getMonth()
    if (month === lastMonth) continue
    lastMonth = month
    if (col - lastLabelCol < 3) continue
    lastLabelCol = col
    months.push({ key: `${month}-${col}`, x: round1(offsetX + labelW + col * step), text: `${month + 1}月` })
  }

  return { width, height, months, weekdays, cells: cellsOut }
}

/** 图例：五档色块 + 每档的 Token 范围，与格子共用同一份阈值（色值与档位都只定义一处） */
export function heatLegendItems(thresholds: number[]): { level: number; text: string }[] {
  return [0, 1, 2, 3, 4].map(level => ({ level, text: heatLevelText(level, thresholds) }))
}

/* ─── 板块五：缓存命中率四窗口 ────────────── */

export type CacheRateCell = { key: string; label: string; value: string; sub: string }

export function cacheRateCells(rates: Record<string, CacheRateWindow> | undefined): CacheRateCell[] {
  const data = rates || {}
  const windows: [string, string][] = [
    ['last10m', '近 10 分钟'],
    ['last1h', '近 1 小时'],
    ['last24h', '近 24 小时'],
    ['last7d', '近 7 天'],
  ]
  return windows.map(([key, label]) => {
    const item = data[key] || {}
    const input = Number(item.inputTokens) || 0
    return {
      key,
      label,
      // 没有输入 Token 时命中率没有意义（0/0），给破折号
      value: input ? formatPercent(item.rate) : '—',
      sub: `命中 ${formatTokens(item.hitTokens)} / 输入 ${formatTokens(input)}`,
    }
  })
}

/* ─── 板块六：近 24 小时命中率折线 ────────── */

export type ChartHit = { key: string; x: number; width: number; tip: string }
export type ChartText = { key: string; x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end' }
export type ChartLine = { points: string; dots: { key: string; cx: number; cy: number }[] }

export type CacheTrendView = {
  width: number; height: number
  plotLeft: number; plotW: number; plotH: number; plotTop: number
  grid: { key: string; y: number }[]
  rateTicks: ChartText[]
  tokenTicks: ChartText[]
  rateLine: ChartLine
  tokenLine: ChartLine | null
  dotR: number
  rateLabels: ChartText[]
  tokenLabels: ChartText[]
  hourTicks: ChartText[]
  hits: ChartHit[] | null
}

/**
 * 双轴折线：命中率（左轴，蓝）与总 Token（右轴，琥珀）。
 *
 * ── 为什么两条线画在一张图里 ─────────────────────────────────
 * 命中率与用量是本工具最需要对照着看的一对：用量突然拔高时命中率有没有塌，是判断
 * 「钱花得冤不冤」最直接的一眼。两者的量纲差着好几个数量级（0–100% vs 上亿 Token），
 * 所以各自一条纵轴 —— 共用一条轴时要么 Token 线压平在底部、要么命中率线贴着顶边。
 *
 * ── 读数为什么直接写在点上 ───────────────────────────────────
 * 悬停气泡只能读一个点，而这张图的常态用法是「扫一眼看出哪几个小时爆了量」。命中率与
 * Token 各用自己那条线的颜色标在点的上下两侧；无请求的整点（补零出来的 0%）不标注，
 * 否则会连成一排毫无信息量的「0%」。标注会互相避让：放不下就整条跳过（宁可少标一个，
 * 也不让两串数字叠成一团）—— 跳过的点仍能用悬停气泡读到完整数值。
 *
 * `null` = 这一维没有数据（给空态）。
 */
export function cacheTrendView(series: StatsHour[] | undefined, width: number): CacheTrendView | null {
  const list = Array.isArray(series) ? series : []
  if (!list.length) return null

  // 比单轴版高一档：点的上方要放 Token 标注、下方要放命中率标注
  const height = 230
  const pad = { left: 44, right: 56, top: 26, bottom: 24 }
  const plotW = Math.max(40, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom

  const rates = list.map(item => Number(item.rate) || 0)
  const tokens = list.map(item => Number(item.totalTokens) || 0)
  // 命中率的纵轴上限按真实峰值抬：上游把缓存读取与输入分开上报时命中率会合法地超过
  // 100%，夹到 100% 等于谎报数据，抬上限只是让曲线留在画布里。下限仍是 1（=100%）：
  // 峰值不高时也给它一条完整的百分比轴，否则「今天命中率普遍 60%」会被画成顶满。
  const rateMax = Math.max(1, axisMax(Math.max(...rates)))
  // 用量轴同样按峰值定上限；整段区间一条用量都没记（老后端没给 totalTokens、或这些请求
  // 全失败被清零）时不画这条线也不画右侧刻度 —— 画一条贴地的直线会让人以为「用量就是 0」，
  // 而事实是「这份数据里没有」
  const tokenPeak = Math.max(...tokens)
  const tokenMax = axisMax(tokenPeak)
  const hasTokens = tokenPeak > 0

  const xAt = (index: number) => pad.left + (list.length > 1 ? (plotW * index) / (list.length - 1) : plotW / 2)
  const yRate = (rate: number) => pad.top + plotH - (plotH * rate) / rateMax
  const yTokens = (value: number) => pad.top + plotH - (plotH * value) / tokenMax

  // ── 网格与两侧刻度 ──
  // 网格线跟着命中率的 5 等分走（左轴是主读数），右侧用量刻度贴在同一批横线上：
  // 两条轴都被等分 4 段，所以同一根线在两边各有各的读数
  const grid: CacheTrendView['grid'] = []
  const rateTicks: ChartText[] = []
  const tokenTicks: ChartText[] = []
  for (let i = 0; i <= 4; i += 1) {
    const value = (rateMax * i) / 4
    const y = round1(yRate(value))
    const pct = value * 100
    grid.push({ key: `g${i}`, y })
    rateTicks.push({
      key: `r${i}`, x: pad.left - 8, y, anchor: 'end',
      text: `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`,
    })
    if (hasTokens) {
      tokenTicks.push({
        key: `t${i}`, x: round1(pad.left + plotW + 8), y, anchor: 'start',
        text: axisText((tokenMax * i) / 4, tokenMax),
      })
    }
  }

  // ── 折线 ──
  // 点也要画，而且单点时要画得更醒目：polyline 只有一个点时连不出线段（SVG 折线至少要两个
  // 点才有笔画），此时「整张图」就剩这一个圆点，半径还按常态的 2.5 会小到像渲染失败。
  // 线色由 cls 对应的 CSS 规则决定（.chart-line.rate / .tokens），两条线的颜色只在 CSS 里各定义一次
  const dotR = list.length === 1 ? 4.5 : 2.5
  const lineOf = (values: number[], yOf: (value: number) => number): ChartLine => ({
    points: values.map((value, index) => `${round1(xAt(index))},${round1(yOf(value))}`).join(' '),
    dots: values.map((value, index) => ({
      key: `d${index}`, cx: round1(xAt(index)), cy: round1(yOf(value)),
    })),
  })

  // ── 点上的读数标注（带互相避让）──
  const boxes: { left: number; right: number; top: number; bottom: number }[] = []
  const label = (
    x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end',
  ): ChartText | null => {
    const w = textWidth(text)
    const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x
    const box = { left, right: left + w, top: y - 8.5, bottom: y + 2.5 }
    // 留 2px 横向、1px 纵向的呼吸：贴着不重叠也算「挤在一起」，一样难认
    if (boxes.some(item => box.left < item.right + 2 && box.right > item.left - 2
      && box.top < item.bottom + 1 && box.bottom > item.top - 1)) return null
    boxes.push(box)
    return { key: `${text}-${x}-${y}`, x: round1(x), y: round1(y), text, anchor }
  }

  /** 首尾两点的标注贴到画布边缘就会被裁掉一半，这里按「会不会越界」改对齐方式：
   *  居中的串若往左探出绘图区就改成左对齐，往右探出就改成右对齐；中间的点永远居中。 */
  const anchorFor = (x: number, text: string): 'start' | 'middle' | 'end' => {
    const half = textWidth(text) / 2
    if (x - half < pad.left - 6) return 'start'
    if (x + half > pad.left + plotW + 6) return 'end'
    return 'middle'
  }

  // 先标用量（字宽、更易被挤掉），再标命中率（短、多半放得下）—— 顺序反过来的话，
  // 长串数字会因为先被短标签占位而大面积消失
  const tokenLabels: ChartText[] = []
  if (hasTokens) {
    list.forEach((item, index) => {
      if (!(Number(item.totalTokens) > 0)) return
      // 点的上方；顶到画布边时翻到点下方（最高那个点的标注只能这么安放）
      const y = yTokens(tokens[index])
      const above = y - 12 >= pad.top - 10
      const text = formatTokens(tokens[index])
      const placed = label(xAt(index), above ? y - 12 : y + 13, text, anchorFor(xAt(index), text))
      if (placed) tokenLabels.push({ ...placed, key: `tl${index}` })
    })
  }

  const rateLabels: ChartText[] = []
  list.forEach((item, index) => {
    // 无请求的整点不标：它是补零出来的 0%，标出来只会连成一排 0%
    const used = (Number(item.inputTokens) || 0) + (Number(item.hitTokens) || 0) > 0
    if (!used) return
    const y = yRate(rates[index])
    // 点的下方；贴到横轴时翻到点上方，避免和刻度文字叠在一起
    const below = y + 15 <= pad.top + plotH + 8
    const text = formatPercent(rates[index])
    const placed = label(xAt(index), below ? y + 13 : y - 7, text, anchorFor(xAt(index), text))
    if (placed) rateLabels.push({ ...placed, key: `rl${index}` })
  })

  // 热区按「整点带宽」铺满，鼠标落在两个点之间也能读到最近的那个点的数值。左右两端各会
  // 超出半个带宽，这里夹回绘图区：越界的那半截会盖住 Y 轴标签，悬停刻度文字却弹出
  // 「某小时的命中率」很突兀。tabindex="-1" 与热力图格子同理：不进 Tab 序列，但仍享受气泡。
  const band = list.length > 1 ? plotW / (list.length - 1) : plotW
  const plotLeft = pad.left
  const plotRight = pad.left + plotW
  const hits: ChartHit[] | null = list.length <= TIP_LIMIT
    ? list.map((item, index) => {
      const tip = `${dayLabel(String(item.hour).slice(0, 10))} ${hourText(item.hour)}`
        + ` · 命中率 ${formatPercent(item.rate)}`
        + ` · 总 ${formatTokens(item.totalTokens)} tokens`
        + `（命中 ${formatTokens(item.hitTokens)} / 输入 ${formatTokens(item.inputTokens)}）`
      const left = Math.max(plotLeft, xAt(index) - band / 2)
      const right = Math.min(plotRight, xAt(index) + band / 2)
      return { key: `h${index}`, x: round1(left), width: round1(right - left), tip }
    })
    : null

  // 每 3 小时一个刻度（24 点 → 8 个）；首尾两个用 start/end 对齐，免得溢出画布
  const tickStep = Math.max(1, Math.ceil(list.length / 8))
  const hourTicks: ChartText[] = []
  for (let i = 0; i < list.length; i += tickStep) {
    const last = i + tickStep >= list.length
    hourTicks.push({
      key: `x${i}`, x: round1(xAt(i)), y: height - 8,
      anchor: i === 0 ? 'start' : last ? 'end' : 'middle',
      text: hourText(list[i].hour),
    })
  }

  return {
    width, height, plotLeft, plotW, plotH, plotTop: pad.top,
    grid, rateTicks, tokenTicks,
    rateLine: lineOf(rates, yRate),
    tokenLine: hasTokens ? lineOf(tokens, yTokens) : null,
    dotR, rateLabels, tokenLabels, hourTicks, hits,
  }
}

/* ─── 板块七：按天 Token 柱状图 ───────────── */

export type DailyTrendView = {
  width: number; height: number
  plotLeft: number; plotW: number; plotH: number; plotTop: number
  grid: { key: string; x1: number; y: number; x2: number }[]
  valueTicks: ChartText[]
  bars: { key: string; x: number; y: number; width: number; height: number; rx: number; tip: string; nativeTip: boolean }[]
  barLabels: ChartText[]
  dateTicks: ChartText[]
  hits: ChartHit[] | null
  /** 全为 0：不画网格也不画柱子，给一句明确的说明（否则整块图空得像渲染失败） */
  blank: boolean
}

/**
 * 按天 Token 柱状图。柱顶直接标出当天的用量。
 *
 * 标注的取舍与折线图一致（见 cacheTrendView）：给的是「扫一眼看量级」的读数，所以不必
 * 每根柱子都标 —— 柱子密到标注必然重叠时，只标当区间里最大的那几根，其余靠悬停气泡读。
 * 这样图始终是干净的，而峰值一眼可见。
 */
/** 曲线的指标维度：Token 用量，或请求次数。两个数后端都给了，切一下就能换口径。 */
export type UsageMetric = 'tokens' | 'requests'

/** 一条维度序列点（后端 `trendByModel` / `trendByAccount` 的形状）。 */
export type StatsUsagePoint = { date?: string; name?: string; tokens?: number; requests?: number }

/** 多序列曲线里的一条线。 */
export type DailyUsageSeries = {
  name: string
  color: string
  /** 折线（`x,y x,y`）—— 保留给「直线」模式与命中区域用 */
  points: string
  /** 平滑曲线的 SVG path `d`（Catmull-Rom 转三次贝塞尔）—— 「曲线」模式用 */
  path: string
  /** 柱状：每根柱子的矩形与读数 —— 「柱状」模式用 */
  bars: { key: string; x: number; y: number; w: number; h: number; tip: string }[]
  total: number
  dots: { key: string; x: number; y: number; tip: string }[]
}

/** 图表形态（2026-10-10 用户要求「两种可选：曲线 和 柱状」）。 */
export type UsageChartShape = 'curve' | 'bar'

/**
 * 平滑曲线路径：Catmull-Rom 转三次贝塞尔。
 *
 * `tension` 取 0.16 而不是常见的 0.5/0.2 —— 用量数据**非负且常有 0**，
 * 张力大会让曲线在低谷处「过冲」到 0 以下（视觉上像负用量）。0.16 足够柔和
 * 又基本不过冲；再加 `floor` 兜底把控制点夹回 0 线以上。
 */
function smoothPath(pts: { x: number; y: number }[], floor: number): string {
  if (pts.length < 2) return ''
  const tension = 0.16
  const clamp = (y: number) => Math.max(floor, y)
  let d = `M ${round1(pts[0].x)} ${round1(pts[0].y)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    const c1x = p1.x + (p2.x - p0.x) * tension
    const c1y = clamp(p1.y + (p2.y - p0.y) * tension)
    const c2x = p2.x - (p3.x - p1.x) * tension
    const c2y = clamp(p2.y - (p3.y - p1.y) * tension)
    d += ` C ${round1(c1x)} ${round1(c1y)}, ${round1(c2x)} ${round1(c2y)}, ${round1(p2.x)} ${round1(p2.y)}`
  }
  return d
}

export type DailyUsageView = {
  width: number
  height: number
  plotLeft: number
  plotTop: number
  plotW: number
  plotH: number
  grid: { key: string; x1: number; y: number; x2: number }[]
  valueTicks: ChartText[]
  dateTicks: ChartText[]
  series: DailyUsageSeries[]
  blank: boolean
}

/**
 * 曲线配色：**按用量排名分配，最大的那条是红色**，与用量环形图同一口径
 * （见 `TIP_MODELS`：同一份报表里换个维度看，配色口径不变）。
 */
const USAGE_COLORS = [
  '#e5484d', '#0090ff', '#30a46c', '#f76b15',
  '#8e4ec6', '#e93d82', '#12a594', '#978365',
]

/**
 * 每日用量曲线（按模型 / 按账号拆成多条线）。
 *
 * ── 为什么缺的日子补 0，而不是断线 ──────────────────────────
 * 某天某模型没有请求，语义就是**那天用了 0**（不是"没有数据"）——
 * 断线会让人以为那几天这个模型消失了。补 0 画出来的线更贴事实。
 *
 * ── 日期轴为什么要在序列之外单独铺 ──────────────────────────
 * 后端只吐出**有数据的**（天 × 维度）条目，整段没用的日子根本不会出现。
 * 直接按条目画会把「10-01 有、10-02 整天没用、10-03 有」压缩成相邻两点，
 * 曲线会把中间的空白吃掉。所以这里逐日铺满，缺的补 0。
 *
 * ── 为什么铺满的基准是「所选窗口」而不是「数据首尾」（2026-10-05）────
 * 基准此前取数据首尾：选「7 天」但用量记录只有 2 天时，轴就缩成 2 天，
 * 用户原话「七天怎么只有 2 天」。轴应该覆盖**所选档位**（调用方用
 * rangeWindowOf 算好窗口传进来）；与数据首尾取**并集**是防御 —— 手改
 * 时钟等边界把条目甩到窗口外时，别把那些点从图上裁掉。all 档没有固定
 * 窗口（窗口为 undefined），退回数据首尾。
 */
/** 报表档位 → 日期窗口（终点一律是今天：today=当天；7/30=往前 N-1 天；
 *  month=本月 1 号；all 无固定窗口 → undefined）。给 dailyUsageView 铺轴用：
 *  轴要覆盖所选档位，而不是从第一条数据开始 —— 否则「7 天」在数据只有
 *  2 天时会缩成 2 天（2026-10-05 用户实测报告）。 */
export function rangeWindowOf(range: string): { first: string; last: string } | undefined {
  const today = new Date()
  const last = dateKeyOf(today)
  if (range === 'today') return { first: last, last }
  if (range === '7' || range === '30') {
    const first = new Date(today.getTime() - (Number(range) - 1) * 86400000)
    return { first: dateKeyOf(first), last }
  }
  if (range === 'month') {
    return { first: dateKeyOf(new Date(today.getFullYear(), today.getMonth(), 1)), last }
  }
  return undefined
}

export function dailyUsageView(
  points: StatsUsagePoint[] | undefined,
  width: number,
  metric: UsageMetric = 'tokens',
  window?: { first: string; last: string },
): DailyUsageView | null {
  const list = (Array.isArray(points) ? points : []).filter(item => item && item.date)
  if (!list.length) return null

  const height = 240
  const pad = { left: 50, right: 14, top: 16, bottom: 26 }
  const plotW = Math.max(40, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom

  // 日期轴：窗口 ∪ 数据首尾，之间逐日铺满（见函数说明）
  const allDates = Array.from(new Set(list.map(item => String(item.date)))).sort()
  const dates: string[] = []
  const dataFirst = parseDay(allDates[0])
  const dataLast = parseDay(allDates[allDates.length - 1])
  const winFirst = window?.first ? parseDay(window.first) : undefined
  const winLast = window?.last ? parseDay(window.last) : undefined
  const union = (
    a: Date | undefined,
    b: Date | undefined,
    pick: (x: number, y: number) => number,
  ): Date | undefined => (a && b ? new Date(pick(a.getTime(), b.getTime())) : a || b)
  const first = union(winFirst, dataFirst, Math.min)
  const last = union(winLast, dataLast, Math.max)
  if (first && last) {
    const cursor = new Date(first.getTime())
    // 上限兜底：手改保留期把区间撑到十年也不会把图画爆
    while (cursor.getTime() <= last.getTime() && dates.length < 400) {
      dates.push(dateKeyOf(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }
  }
  if (!dates.length) return null
  const indexOf = new Map(dates.map((date, index) => [date, index]))

  // 按 name 分组求和（同名同日的多条要合并，否则后一条会覆盖前一条）
  const byName = new Map<string, number[]>()
  const totals = new Map<string, number>()
  for (const item of list) {
    const name = String(item.name || '未知')
    if (!byName.has(name)) byName.set(name, new Array(dates.length).fill(0))
    const row = byName.get(name)!
    const index = indexOf.get(String(item.date))
    if (index === undefined) continue
    const tokens = Number(metric === 'requests' ? item.requests : item.tokens) || 0
    row[index] += tokens
    totals.set(name, (totals.get(name) || 0) + tokens)
  }

  // 排名：用量大的在前（配色与图例都按它排）
  const ranked = Array.from(byName.keys()).sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0))
  const peak = Math.max(0, ...ranked.map(name => totals.get(name) || 0))
  const yMax = axisMax(peak)
  const baseY = pad.top + plotH
  const step = dates.length > 1 ? plotW / (dates.length - 1) : 0
  const xAt = (index: number) => pad.left + (dates.length > 1 ? step * index : plotW / 2)
  const yAt = (value: number) => pad.top + plotH - (plotH * value) / yMax
  const blank = peak <= 0

  const grid: DailyUsageView['grid'] = []
  const valueTicks: ChartText[] = []
  if (!blank) {
    for (let i = 0; i <= 4; i += 1) {
      const value = (yMax * i) / 4
      const y = round1(yAt(value))
      grid.push({ key: `g${i}`, x1: pad.left, y, x2: round1(pad.left + plotW) })
      valueTicks.push({ key: `v${i}`, x: pad.left - 8, y, anchor: 'end', text: axisText(value, yMax) })
    }
  }

  // 日期刻度：**短区间每天都标**（用紧凑标签 `9/28`），长区间才抽稀到最多 6 个。
  // 为什么要分档：完整标签「9月28日 周一」有 8 个字，7 天排开必然重叠 ⇒ 只能隔天标
  // ⇒「近 7 天」看起来像 4 天（2026-10-04 用户原话「近七天 怎么不是7天呢」）。
  const dateTicks: ChartText[] = []
  const shortRange = dates.length <= 10
  const labelStep = shortRange ? 1 : Math.max(1, Math.ceil(dates.length / 6))
  dates.forEach((date, index) => {
    if (index % labelStep !== 0 && index !== dates.length - 1) return
    dateTicks.push({
      key: `d${date}`,
      x: round1(xAt(index)),
      y: pad.top + plotH + 16,
      anchor: index === 0 ? 'start' : index === dates.length - 1 ? 'end' : 'middle',
      text: shortRange ? shortDayLabel(date) : dayLabel(date),
    })
  })

  // 柱宽：按「每个日期格」分给全部序列（分组柱），留 22% 间隙
  const groupW = dates.length > 1 ? plotW / (dates.length - 1) : plotW
  const slot = Math.max(3, groupW * 0.62)
  const barW = Math.max(2, slot / Math.max(1, ranked.length))
  const baseline = pad.top + plotH

  const series: DailyUsageSeries[] = ranked.map((name, rank) => {
    const row = byName.get(name)!
    const tipOf = (index: number) =>
      `${dayLabel(dates[index])} · ${name} · ${metric === 'requests' ? `${formatInt(row[index])} 次请求` : `${formatTokens(row[index])} tokens`}`
    const pts = row.map((value, index) => ({ x: xAt(index), y: yAt(value) }))
    const points = pts.map(p => `${round1(p.x)},${round1(p.y)}`).join(' ')
    const path = smoothPath(pts, pad.top)
    const dots = pts
      .map((p, index) => ({ key: `${name}-${dates[index]}`, x: round1(p.x), y: round1(p.y), tip: tipOf(index) }))
      .filter((_, index) => row[index] > 0)
    const bars = pts
      .map((p, index) => {
        const w = barW
        const x = p.x - slot / 2 + rank * barW + (slot - barW * ranked.length) / 2
        const h = Math.max(0, baseline - p.y)
        return { key: `${name}-${dates[index]}`, x: round1(x), y: round1(p.y), w: round1(w), h: round1(h), tip: tipOf(index) }
      })
      .filter((_, index) => row[index] > 0)
    return {
      name, color: USAGE_COLORS[rank % USAGE_COLORS.length],
      points, path, bars, total: totals.get(name) || 0, dots,
    }
  })

  return { width, height, plotLeft: pad.left, plotTop: pad.top, plotW, plotH, grid, valueTicks, dateTicks, series, blank }
}

/** 曲线读数：Token 走 `formatTokens`（带量级），请求数走 `formatInt`（整数）。 */
export function usageMetricText(value: number, metric: UsageMetric): string {
  return metric === 'requests' ? `${formatInt(value)} 次` : `${formatTokens(value)} tokens`
}

/** `YYYY-MM-DD`（本地日）——与 `daily_trend` 的键同源。 */
function dateKeyOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function dailyTrendView(series: StatsDay[] | undefined, width: number): DailyTrendView | null {
  const list = Array.isArray(series) ? series : []
  if (!list.length) return null

  // 比不带标注的版本高一档：柱顶要留出写读数的位置（见 pad.top）
  const height = 240
  const pad = { left: 50, right: 14, top: 26, bottom: 26 }
  const plotW = Math.max(40, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom

  const values = list.map(item => Number(item.tokens) || 0)
  const peak = Math.max(...values)
  const yMax = axisMax(peak)
  const step = plotW / list.length
  // 极长区间（手改保留期才会出现）下柱子只剩一两像素：此时不再压窄，保证看得见
  const barW = Math.max(1, Math.min(28, step * 0.68))
  const baseY = pad.top + plotH
  const yAt = (value: number) => pad.top + plotH - (plotH * value) / yMax
  const tips = list.length <= TIP_LIMIT

  // 全为 0 时柱高为 0，整块图会空得像渲染失败：不画网格（此时五个刻度会缩成 0/0/0/0/0
  // 这类重复标签），改为给一句明确的说明
  const blank = peak <= 0

  const grid: DailyTrendView['grid'] = []
  const valueTicks: ChartText[] = []
  if (!blank) {
    for (let i = 0; i <= 4; i += 1) {
      const value = (yMax * i) / 4
      const y = round1(yAt(value))
      grid.push({ key: `g${i}`, x1: pad.left, y, x2: round1(pad.left + plotW) })
      // 刻度文案交给 units.js（中文档按各刻度自己的量级，英文档按整条轴统一）
      valueTicks.push({ key: `v${i}`, x: pad.left - 8, y, anchor: 'end', text: axisText(value, yMax) })
    }
  }

  const bars: DailyTrendView['bars'] = []
  list.forEach((item, index) => {
    const value = Number(item.tokens) || 0
    if (value <= 0) return   // 无数据的日子不画柱子，留空比画一个 0 高的假柱子诚实
    const y = yAt(value)
    bars.push({
      key: String(item.date ?? index),
      x: round1(pad.left + step * index + (step - barW) / 2),
      y: round1(y),
      width: round1(barW),
      height: round1(Math.max(1, baseY - y)),
      rx: barW > 4 ? 2 : 1,
      tip: `${dayLabel(item.date)} · ${formatTokens(value)} tokens · ${formatInt(item.requests)} 次请求`,
      // 超长区间不挂 data-tip 时改用 SVG 原生 <title>：提示成本降到零，hover 仍有读数
      nativeTip: !tips,
    })
  })

  // 柱顶读数：每根柱子都要放得下才逐一标注（区间一长、柱子一密就必然重叠）。放不下时退成
  // 「只标最大的那几根」—— 峰值是最该一眼看到的那个数，而每一根的具体值仍能从气泡读到。
  const texts = list.map(item => (Number(item.tokens) > 0 ? formatTokens(item.tokens) : ''))
  const widest = Math.max(0, ...texts.map(textWidth))
  const allFit = texts.every(text => !text) || widest + 4 <= step   // +4：相邻标注之间留一点缝

  // 退让模式下取用量最高的前几名；并列多少就取多少（上限只是防极端区间标出一大串）
  const marked = new Set<number>()
  if (!allFit) {
    list
      .map((item, index) => ({ index, value: Number(item.tokens) || 0 }))
      .filter(item => item.value > 0)
      .sort((left, right) => right.value - left.value)
      .slice(0, 8)
      .forEach(item => marked.add(item.index))
  }

  const barLabels: ChartText[] = []
  list.forEach((item, index) => {
    if (!texts[index]) return
    if (!allFit && !marked.has(index)) return
    const y = yAt(Number(item.tokens) || 0) - 6
    // 顶到画布边（柱子接近 100%）时翻到柱子内侧，免得文字被裁掉
    const inside = y - 9 < pad.top - 10
    barLabels.push({
      key: `b${index}`,
      x: round1(pad.left + step * index + step / 2),
      y: round1(inside ? y + 13 : y),
      anchor: 'middle',
      text: texts[index],
    })
  })

  // 热区整列铺满（含零值日），鼠标扫过任何一列都能读到当天读数
  const hits: ChartHit[] | null = tips
    ? list.map((item, index) => ({
      key: `h${index}`,
      x: round1(pad.left + step * index),
      width: round1(step),
      tip: `${dayLabel(item.date)} · ${formatTokens(item.tokens)} tokens · ${formatInt(item.requests)} 次请求`,
    }))
    : null

  // 刻度稀疏：最多 6 个，且末位日期一定标出来 —— 等距取样常常落下「今天」，
  // 而今天恰恰是用户最先看的那一格
  const labelStep = Math.max(1, Math.ceil(list.length / 6))
  const marks: number[] = []
  for (let i = 0; i < list.length; i += labelStep) marks.push(i)
  if (marks[marks.length - 1] !== list.length - 1) marks.push(list.length - 1)
  const dateTicks: ChartText[] = marks.map(index => {
    const only = list.length === 1
    const last = !only && index === list.length - 1
    const date = parseDay(list[index].date)
    return {
      key: `d${index}`,
      x: only ? pad.left + plotW / 2 : last ? pad.left + plotW : round1(pad.left + step * index + step / 2),
      y: height - 8,
      anchor: only ? 'middle' : last ? 'end' : index === 0 ? 'start' : 'middle',
      text: `${date.getMonth() + 1}/${date.getDate()}`,
    }
  })

  return {
    width, height, plotLeft: pad.left, plotW, plotH, plotTop: pad.top,
    grid, valueTicks, bars, barLabels, dateTicks, hits, blank,
  }
}
