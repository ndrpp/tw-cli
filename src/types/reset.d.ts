// Lib declarations that would otherwise hand out `any`. Merged overloads come first, so these win: parsed JSON
// is `unknown` until narrowed (src/util/json.ts), like a value from any other untrusted source.

interface JSON {
  parse(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown;
}

interface ArrayConstructor {
  isArray(arg: unknown): arg is unknown[];
}

interface Body {
  json(): Promise<unknown>;
}

interface Response {
  json(): Promise<unknown>;
}
