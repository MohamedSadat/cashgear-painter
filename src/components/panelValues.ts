// Values the properties panel's rows show for a selection whose objects may disagree.

/** Selected objects disagree on a value. */
export const MIXED = Symbol('mixed')
export type Value<T> = T | typeof MIXED

/** The value every item has, or MIXED. */
export function shared<T>(values: T[]): Value<T> {
  return values.every((v) => v === values[0]) ? values[0] : MIXED
}
