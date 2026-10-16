// bezier-js ships no types; these cover the parts the editor uses.
declare module 'bezier-js' {
  export interface Point {
    x: number
    y: number
  }

  export interface MinMax {
    min: number
    max: number
  }

  export class Bezier {
    constructor(...coords: number[])
    points: Point[]
    bbox(): { x: MinMax; y: MinMax }
    getLUT(steps?: number): Point[]
    split(t: number): { left: Bezier; right: Bezier }
    project(point: Point): Point & { t: number }
  }
}
