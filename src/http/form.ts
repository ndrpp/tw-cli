// Form encoding compatible with jQuery 3.5 $.param (what Ajax.remoteCall uses):
// null/undefined become "", booleans "true"/"false", %20 becomes "+", nested objects/arrays use
// bracket notation (a[b]=1, a[0]=x), matching jQuery's non-traditional mode.
type Scalar = string | number | boolean | null | undefined;
export type FormValue = Scalar | FormValue[] | { [k: string]: FormValue };

function enc(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

function build(prefix: string, value: FormValue, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      const isComplex = v !== null && typeof v === 'object';
      build(`${prefix}[${isComplex ? i : ''}]`, v, out);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) build(`${prefix}[${k}]`, value[k], out);
  } else {
    out.push(`${enc(prefix)}=${enc(value == null ? '' : String(value))}`);
  }
}

export function jqueryParam(data: Record<string, FormValue>): string {
  const out: string[] = [];
  for (const k of Object.keys(data)) build(k, data[k], out);
  return out.join('&');
}
