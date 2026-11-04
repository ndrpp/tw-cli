// With exactOptionalPropertyTypes an optional prop may be left out but not set to undefined (Ink's Text and
// Box props are typed that way). `defined({ color: cond ? 'red' : undefined })` drops the undefined keys and
// types them as optional, so props can still be written inline.
import { entries } from './json.ts';

type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function defined<const T extends object>(o: T): Defined<T> {
  return Object.fromEntries(entries(o).filter(([, v]) => v !== undefined)) as Defined<T>;
}
