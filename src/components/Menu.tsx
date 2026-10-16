import type { LucideIcon } from 'lucide-react'
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react'

export interface MenuItem {
  label: string
  shortcut?: string
  icon?: LucideIcon
  disabled?: boolean
  run(): void | Promise<void>
}

interface MenuProps {
  label: string
  groups: MenuItem[][] // separated by lines
  // Called on a pick, Esc, Tab or a press outside; the owner unmounts the menu.
  onClose(): void
  // Presses inside this element, such as the button that toggles the menu, don't close it.
  ignoreRef?: RefObject<HTMLElement | null>
  // Esc puts the focus back here.
  returnFocusRef?: RefObject<HTMLElement | null>
  // A menu placed with position: fixed moves back inside the window when it would stick out.
  keepInView?: boolean
  className?: string
  style?: CSSProperties
}

const ENABLED_ITEM = '[role=menuitem]:not([disabled])'

/**
 * A menu of buttons, focused on its first item when it opens. Arrow keys move between items; Esc,
 * Tab, a pick or a press outside closes it. Items are 40 px tall, for fingers.
 */
export function Menu({
  label,
  groups,
  onClose,
  ignoreRef,
  returnFocusRef,
  keepInView = false,
  className = '',
  style,
}: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    if (keepInView) {
      const box = menu.getBoundingClientRect()
      const margin = 8
      if (box.right > window.innerWidth - margin) {
        menu.style.left = `${Math.max(margin, window.innerWidth - margin - box.width)}px`
      }
      if (box.bottom > window.innerHeight - margin) {
        menu.style.top = `${Math.max(margin, window.innerHeight - margin - box.height)}px`
      }
    }
    menu.querySelector<HTMLElement>(ENABLED_ITEM)?.focus()
  }, [keepInView])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || ignoreRef?.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose, ignoreRef])

  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ENABLED_ITEM) ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    } else if (e.key === 'Escape') {
      onClose()
      returnFocusRef?.current?.focus()
    } else if (e.key === 'Tab') {
      onClose()
      return
    } else return
    // Not for the canvas shortcuts: Esc would also drop the selection.
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`z-50 w-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg ${className}`}
      style={style}
    >
      {groups.map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <div role="separator" className="my-1 h-px bg-neutral-200" />}
          {group.map(({ label: itemLabel, shortcut, icon: Icon, disabled, run }, j) => (
            <button
              key={j}
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => {
                onClose()
                // Synchronously inside the click, so a file picker may open.
                void run()
              }}
              className="flex h-10 w-full items-center gap-3 px-3 text-left text-sm text-neutral-800 hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none disabled:text-neutral-400 disabled:hover:bg-transparent"
            >
              {Icon && <Icon size={18} className="shrink-0 text-neutral-500" />}
              <span className="min-w-0 flex-1 truncate">{itemLabel}</span>
              {shortcut && (
                <span className="hidden text-xs text-neutral-400 sm:inline">{shortcut}</span>
              )}
            </button>
          ))}
        </Fragment>
      ))}
    </div>
  )
}
