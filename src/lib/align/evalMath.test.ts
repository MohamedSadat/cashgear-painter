import { describe, expect, it } from 'vitest'
import { evalMath } from './evalMath'

describe('evalMath', () => {
  it.each([
    ['120', 120],
    [' 12.5 ', 12.5],
    ['.5', 0.5],
    ['5.', 5],
    ['-40', -40],
    ['--4', 4],
    ['+7', 7],
    ['200/3', 200 / 3],
    ['100 + 20 * 2', 140],
    ['(100 + 20) * 2', 240],
    ['10 - 4 - 3', 3],
    ['64 / 4 / 2', 8],
    ['3 × 4 ÷ 2', 6],
    ['-(2 + 3) * -2', 10],
  ])('works out %j as %d', (text, value) => {
    expect(evalMath(text)).toBeCloseTo(value, 12)
  })

  it.each([
    '',
    '  ',
    'abc',
    '1,5',
    '1.2.3',
    '2 +',
    '(1 + 2',
    '1 + 2)',
    '2 3',
    '1/0',
    '0/0',
    '12px',
  ])('refuses %j', (text) => {
    expect(evalMath(text)).toBeNull()
  })
})
