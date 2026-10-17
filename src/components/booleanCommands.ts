import {
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  type LucideIcon,
} from 'lucide-react'
import type { BooleanKind } from '../lib/boolean/booleanOp'

export interface BooleanCommand {
  kind: BooleanKind
  label: string
  description: string // what is kept, for the button's title
  keys: string
  icon: LucideIcon
}

/** The four boolean operations, as the properties panel and the canvas's menu offer them. */
export const BOOLEAN_COMMANDS: BooleanCommand[] = [
  {
    kind: 'union',
    label: 'Union',
    description: 'one shape covering them all',
    keys: 'Ctrl+Alt+U',
    icon: SquaresUnite,
  },
  {
    kind: 'subtract',
    label: 'Subtract',
    description: 'the bottom shape minus the ones above it',
    keys: 'Ctrl+Alt+S',
    icon: SquaresSubtract,
  },
  {
    kind: 'intersect',
    label: 'Intersect',
    description: 'only what they all cover',
    keys: 'Ctrl+Alt+I',
    icon: SquaresIntersect,
  },
  {
    kind: 'exclude',
    label: 'Exclude',
    description: 'what an odd number of them cover',
    keys: 'Ctrl+Alt+X',
    icon: SquaresExclude,
  },
]
