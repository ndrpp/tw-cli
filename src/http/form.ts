// Form encoding compatible with jQuery 3.5 $.param (what Ajax.remoteCall uses):
// null/undefined become "", booleans "true"/"false", %20 becomes "+", nested objects/arrays use
// bracket notation (a[b]=1, a[0]=x), matching jQuery's non-traditional mode.
type Scalar = string | number | boolean | null | undefined;
export type FormValue = Scalar | FormValue[] | { [key: string]: FormValue };

function enc(text: string): string {
  return encodeURIComponent(text).replace(/%20/g, '+');
}

function build(prefix: string, value: FormValue, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((currentValue, index) => {
      const isComplex = currentValue !== null && typeof currentValue === 'object';
      build(`${prefix}[${isComplex ? index : ''}]`, currentValue, out);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) build(`${prefix}[${key}]`, value[key], out);
  } else {
    out.push(`${enc(prefix)}=${enc(value == null ? '' : String(value))}`);
  }
}

export function jqueryParam(data: Record<string, FormValue>): string {
  const out: string[] = [];
  for (const key of Object.keys(data)) build(key, data[key], out);
  return out.join('&');
}
