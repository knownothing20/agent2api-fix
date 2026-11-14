import * as React from 'react'
import { Button as BaseButton } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './lib/cn'

/**
 * 按钮。
 *
 * 形态与 shadcn/ui 的 Button 对齐：variant 取 default / outline / secondary /
 * ghost / destructive / link，size 取 default / xs / sm / lg / icon / icon-xs /
 * icon-sm / icon-lg —— 名字与档位都照标准来，按 shadcn 的习惯写就能命中。
 * 样式值取项目令牌（见 styles/theme.css），观感与既有界面一致。
 *
 * 两处本项目的扩展（shadcn 标准里没有，但既有界面需要）：
 *   · `variant='dashed'` 虚线描边，表达「入口」而不是「操作」；
 *   · `size='2xs'` / `'icon-2xs'` 16px 小件档，给药丸（chip）内部用。
 * 它们仍然是 variant / size 的取值，不另起 prop。
 *
 * 与 ui/css/components.css 那套类名的对应：button.primary → default，
 * 基础 button → outline，button.danger → destructive，button.sm → sm，button.icon → icon。
 *
 * 交互层交给 Base UI 的 Button：原生 `<button>` 的薄封装，补了 data-pressed /
 * data-disabled 等状态属性。
 */

const buttonVariants = cva(
  [
    'group/button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border',
    'font-medium transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-out',
    'outline-none select-none active:translate-y-[0.5px]',
    'disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        /** 主按钮：平铺主色 + 近白文字 */
        default:
          'border-primary bg-primary font-semibold text-primary-on shadow-glow hover:border-primary-hover hover:bg-primary-hover',
        /** 默认按钮：控件底 + 控件描边 */
        outline:
          'border-control-border bg-control text-foreground shadow-1 hover:border-control-border-hover hover:bg-control-hover',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost:
          'border-transparent bg-transparent text-subtle shadow-none hover:bg-control-hover hover:text-foreground',
        /** 危险按钮：语义柔底 + 语义描边 */
        destructive:
          'border-destructive-bd bg-destructive-soft text-destructive hover:bg-destructive-hover',
        /**
         * 虚线描边按钮：语义是「入口」而不是「操作」—— 加一条映射、加一项白名单
         * 这类「这里还能再添一个」的位置用它，与旁边那些实心按钮一眼分开
         * （对应 ui/css 的 `.alias-add` / `.pv-add`）。
         */
        dashed:
          'border-dashed border-border-strong bg-transparent text-muted-foreground shadow-none hover:border-primary hover:text-primary-fg',
        link: 'border-transparent bg-transparent text-primary shadow-none underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 rounded-md px-3 text-[12.5px]',
        /**
         * 药丸内的小件档（16px）：映射 chip 里的等级标与删除 ×。
         * 再往下的 24px（xs / icon-xs）塞进 22px 高的药丸里会把整行撑高，
         * 而 chip 的行高是表格行高的一部分 —— 撑高一行就是整张表变松。
         */
        '2xs': 'h-4 rounded-pill px-1.5 text-[10px]',
        xs: 'h-6 rounded-sm px-2 text-[11.5px]',
        sm: 'h-[26px] rounded-sm px-2.5 text-[12px]',
        lg: 'h-9 rounded-md px-4 text-[13px]',
        icon: 'h-[30px] w-[30px] rounded-md p-0',
        'icon-2xs': 'size-4 rounded-pill p-0',
        'icon-xs': 'size-6 rounded-sm p-0',
        'icon-sm': 'h-[26px] w-[26px] rounded-sm p-0',
        'icon-lg': 'size-9 rounded-md p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

type ButtonProps = Omit<React.ComponentProps<typeof BaseButton>, 'className'> &
  VariantProps<typeof buttonVariants> & {
    className?: string
  }

function Button({ className, variant, size, ...props }: ButtonProps) {
  return <BaseButton className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { Button, buttonVariants, type ButtonProps }
