import * as React from 'react'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { cn } from './lib/cn'

/**
 * 分段控件：一行互斥的档位选择。全站的分段筛选都走这一个组件。
 *
 * 行为层（焦点管理、方向键切换、roving tabindex、单选语义）全部交给 Base UI 的
 * RadioGroup；视觉对齐 ui/css/components.css 的 `.seg` / `.seg-item` /
 * `.seg-thumb` 一族，逐项复刻（容器 2px 内衬、项 24px 高、滑块 0.2s 平移）。
 *
 * 为什么用 RadioGroup 而不是 ToggleGroup：这些都是「多选一」的筛选，
 * 单选语义（`role="radiogroup"`，方向键移动即选中）比切换按钮组
 * （`aria-pressed`，方向键只移焦点、还要 Space/Enter 确认）更贴合用户对
 * 筛选器的预期，读屏播报的也是「单选按钮 已选中」而不是「按下」。
 *
 * Radio 用 Base UI 默认的 `<span role="radio">`，**不要改成 `render={<button />}`
 * 加 `nativeButton`**：那条路会坏掉键盘方向键。RadioRoot 在组内是经 `CompositeItem`
 * 渲染的，props 合并顺序为 `[compositeProps, ...props, elementProps]`，而 `useButton`
 * 生成的 props 排在 compositeProps 之后，会把 CompositeItem 注册的方向键处理覆盖掉
 * —— 实测 button 形态下按方向键焦点纹丝不动，span 形态下正常移动。
 *
 * 选中态用一枚滑动指示器承载，不再让选中项自己变色 —— 这样切换档位时能看到
 * 色块平移过去，而不是硬切。做法是量出选中项的位置与宽度喂给 transform / width
 * （见 measure）。也正因如此，选中项文字不加粗：字重会改元素宽度，切换瞬间整条
 * 控件重新排版、滑块动画的目标位置跟着跳一下。
 */

type SegmentedControlOption<Value extends string> = {
  value: Value
  label: React.ReactNode
  /**
   * 计数徽标：不传就不渲染徽标。
   * 传 0 时整项按「空段」弱化，与账号页筛选的既有约定一致。
   */
  count?: number
  disabled?: boolean
}

type SegmentedControlProps<Value extends string> = {
  options: readonly SegmentedControlOption<Value>[]
  /** 受控选中值：本控件不持有状态，值始终由调用方给 */
  value: Value
  onValueChange: (value: Value) => void
  /** 无障碍名：这一组档位在筛什么 */
  'aria-label': string
  disabled?: boolean
  /** 附加到容器上的类名（弹窗里的紧凑档位就是靠它带尺寸覆盖） */
  className?: string
}

/** 滑块几何：left 相对容器 padding box 的原点（thumb 的 left: 0 正落在那里），ready 表示是否量到了有效值 */
type Thumb = { left: number; width: number; ready: boolean }

function SegmentedControl<Value extends string>({
  options,
  value,
  onValueChange,
  disabled = false,
  className,
  ...props
}: SegmentedControlProps<Value>) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const itemsRef = React.useRef(new Map<Value, HTMLElement>())
  const [thumb, setThumb] = React.useState<Thumb>({ left: 0, width: 0, ready: false })
  /** 首次定位完成后再开过渡，见下面那个 effect */
  const [animate, setAnimate] = React.useState(false)

  // 量选中项的位置与宽度。值没实质变化时就返回原对象，
  // 免得 ResizeObserver 每次回调都触发一轮无谓渲染。
  //
  // 用 rect 之差而不是 offsetLeft：滑块的 left: 0 落在容器的 padding box 原点，
  // 而 offsetLeft 的基准（offsetParent 的 border edge 还是 padding edge）各家
  // 实现说法不一 —— 容器带 1px 描边时，那 1px 的歧义就足以让滑块错位。
  // 减掉 clientLeft 是显式扣掉描边，结果只依赖实际几何。
  const measure = React.useCallback(() => {
    const container = containerRef.current
    const item = itemsRef.current.get(value)
    if (!container || !item) {
      setThumb(prev => (prev.ready ? { ...prev, ready: false } : prev))
      return
    }
    const containerRect = container.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    const left = itemRect.left - containerRect.left - container.clientLeft
    const width = itemRect.width
    setThumb(prev =>
      prev.ready && prev.left === left && prev.width === width ? prev : { left, width, ready: true }
    )
  }, [value])

  // 用 layout effect 而非 effect：测量与回填要在浏览器绘制前完成，
  // 否则首帧会先按旧值画一次，看到滑块从上一个位置滑过去。
  //
  // 观察容器与**所有**选项：只看选中项是不够的 —— 某一项的计数徽标从 9 变 10
  // 会把它自己撑宽、后面的项整体右移，选中项自己却纹丝不动，滑块就会停在旧位置。
  // 依赖里带 options：选项集合被换掉（动态重建）时要重新认领这些节点。
  React.useLayoutEffect(() => {
    measure()
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(container)
    for (const item of itemsRef.current.values()) observer.observe(item)
    return () => observer.disconnect()
  }, [measure, options])

  // 首次定位完成后再打开过渡。刚挂载时滑块停在 translateX(0) / width: 0，
  // 而 measure 里的 getBoundingClientRect 会强制浏览器把这套初始样式先算一遍，
  // 于是回填目标值时 transition 就会生效 —— 用户会看到滑块从最左一路滑过来。
  // 隔一帧再开：这次只改 transition 本身、几何没动，不会产生动画。
  React.useEffect(() => {
    if (!thumb.ready || animate) return
    const id = requestAnimationFrame(() => setAnimate(true))
    return () => cancelAnimationFrame(id)
  }, [thumb.ready, animate])

  return (
    <RadioGroup<Value>
      ref={containerRef}
      data-slot='segmented-control'
      className={cn(
        'relative inline-flex gap-0.5 rounded-md border border-control-border bg-control p-0.5',
        className
      )}
      value={value}
      disabled={disabled}
      onValueChange={next => onValueChange(next)}
      {...props}
    >
      {/* 纯装饰：位置由 JS 喂，交互一律穿透给下面的选项 */}
      <span
        aria-hidden='true'
        data-slot='segmented-thumb'
        data-ready={thumb.ready ? 'true' : 'false'}
        data-animate={animate ? 'true' : 'false'}
        className={cn(
          'pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded-sm bg-primary-soft',
          'data-[ready=false]:opacity-0',
          'data-[animate=true]:transition-[transform,width] data-[animate=true]:duration-200 data-[animate=true]:ease-in-out'
        )}
        style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
      />
      {options.map(option => (
        <Radio.Root
          key={option.value}
          value={option.value}
          data-slot='segmented-item'
          disabled={option.disabled}
          data-zero={option.count === 0 ? 'true' : undefined}
          className={cn(
            'group/seg relative z-[1] inline-flex h-6 items-center gap-[5px] rounded-sm border-0 bg-transparent px-2.5',
            'text-xs font-medium whitespace-nowrap text-subtle select-none',
            'transition-[background-color,color] duration-150 ease-out',
            // hover **只提文字色、不上底色**：这一族的底色是「选中」的专用表达
            // （由滑块画，见文件头说明）。悬停也上底色，会让未选中的那一项看起来
            // 也选中了 —— 2026-10-09 用户实测：两组控件并排时，「按模型」（选中）
            // 与「按账号」（悬停）都带底色，被读成「同一组里选了两个」（「与」），
            // 而它们其实分属两组、各自互斥（「或」）。
            // 用 headless 渲染（无鼠标）对照可复现：去掉 hover 后「按账号」是白底。
            'hover:text-foreground',
            // 选中项让出底色（底色归滑块画），只留文字色
            'data-checked:bg-transparent data-checked:text-primary-fg data-checked:hover:bg-transparent',
            'data-disabled:cursor-not-allowed data-disabled:opacity-40',
            // 计数为 0 的分段弱化；当前选中的那一档即使为 0 也保持正常
            'data-[zero=true]:data-unchecked:opacity-45'
          )}
          ref={(node: HTMLSpanElement | null) => {
            if (node) itemsRef.current.set(option.value, node)
            else itemsRef.current.delete(option.value)
          }}
        >
          {option.label}
          {option.count !== undefined && (
            <span
              className={cn(
                'min-w-4 rounded-pill bg-surface-3 px-[5px] text-center text-[10.5px] font-semibold tabular-nums text-muted-foreground',
                'group-data-checked/seg:bg-primary-tint group-data-checked/seg:text-primary-fg'
              )}
            >
              {option.count}
            </span>
          )}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}

export { SegmentedControl, type SegmentedControlOption, type SegmentedControlProps }
