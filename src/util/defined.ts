// With exactOptionalPropertyTypes an optional prop may be left out but not set to undefined (Ink's Text and
// Box props are typed that way). `defined({ color: cond ? 'red' : undefined })` drops the undefined keys and
// types them as optional, so props can still be written inline.
import { entries } from './json.ts';

type Defined<Value> = { [Key in keyof Value as undefined extends Value[Key] ? never : Key]: Value[Key] } & {
  [Key2 in keyof Value as undefined extends Value[Key2] ? Key2 : never]?: Exclude<Value[Key2], undefined>;
};

export function defined<const Value extends object>(options: Value): Defined<Value> {
  return Object.fromEntries(entries(options).filter(([, value]) => value !== undefined)) as Defined<Value>;
}
