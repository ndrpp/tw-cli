// Literal port of Fingerprint2 v1.8.0's x64hash128 (MurmurHash3 x64 128-bit) as embedded in
// game.php's <script id="fp-script">. 64-bit words are [hi, lo] pairs of 32-bit ints, exactly as in
// the original, so quirks are reproduced bit-for-bit. Note the body loop masks charCodeAt with 255,
// while the tail switch does NOT (chars > 0xFF leak extra bits there).

type U64 = [number, number];
/** A U64 split into four 16-bit limbs, high first. */
type Limbs = [number, number, number, number];

function add(a: U64, b: U64): U64 {
  const e: Limbs = [a[0] >>> 16, a[0] & 0xffff, a[1] >>> 16, a[1] & 0xffff];
  const t: Limbs = [b[0] >>> 16, b[0] & 0xffff, b[1] >>> 16, b[1] & 0xffff];
  const n: Limbs = [0, 0, 0, 0];
  n[3] += e[3] + t[3]; n[2] += n[3] >>> 16; n[3] &= 0xffff;
  n[2] += e[2] + t[2]; n[1] += n[2] >>> 16; n[2] &= 0xffff;
  n[1] += e[1] + t[1]; n[0] += n[1] >>> 16; n[1] &= 0xffff;
  n[0] += e[0] + t[0]; n[0] &= 0xffff;
  return [(n[0] << 16) | n[1], (n[2] << 16) | n[3]];
}

function mul(a: U64, b: U64): U64 {
  const e: Limbs = [a[0] >>> 16, a[0] & 0xffff, a[1] >>> 16, a[1] & 0xffff];
  const t: Limbs = [b[0] >>> 16, b[0] & 0xffff, b[1] >>> 16, b[1] & 0xffff];
  const n: Limbs = [0, 0, 0, 0];
  n[3] += e[3] * t[3]; n[2] += n[3] >>> 16; n[3] &= 0xffff;
  n[2] += e[2] * t[3]; n[1] += n[2] >>> 16; n[2] &= 0xffff;
  n[2] += e[3] * t[2]; n[1] += n[2] >>> 16; n[2] &= 0xffff;
  n[1] += e[1] * t[3]; n[0] += n[1] >>> 16; n[1] &= 0xffff;
  n[1] += e[2] * t[2]; n[0] += n[1] >>> 16; n[1] &= 0xffff;
  n[1] += e[3] * t[1]; n[0] += n[1] >>> 16; n[1] &= 0xffff;
  n[0] += e[0] * t[3] + e[1] * t[2] + e[2] * t[1] + e[3] * t[0]; n[0] &= 0xffff;
  return [(n[0] << 16) | n[1], (n[2] << 16) | n[3]];
}

function rotl(e: U64, t: number): U64 {
  t %= 64;
  if (t === 32) return [e[1], e[0]];
  if (t < 32) return [(e[0] << t) | (e[1] >>> (32 - t)), (e[1] << t) | (e[0] >>> (32 - t))];
  t -= 32;
  return [(e[1] << t) | (e[0] >>> (32 - t)), (e[0] << t) | (e[1] >>> (32 - t))];
}

function shl(e: U64, t: number): U64 {
  t %= 64;
  if (t === 0) return e;
  if (t < 32) return [(e[0] << t) | (e[1] >>> (32 - t)), e[1] << t];
  return [e[1] << (t - 32), 0];
}

const xor = (a: U64, b: U64): U64 => [a[0] ^ b[0], a[1] ^ b[1]];

function fmix(e: U64): U64 {
  e = xor(e, [0, e[0] >>> 1]);
  e = mul(e, [4283543511, 3981806797]);
  e = xor(e, [0, e[0] >>> 1]);
  e = mul(e, [3301882366, 444984403]);
  e = xor(e, [0, e[0] >>> 1]);
  return e;
}

const hex8 = (n: number) => ('00000000' + (n >>> 0).toString(16)).slice(-8);

export function x64hash128(key: string, seed = 0): string {
  key = key || '';
  const rem = key.length % 16;
  const bytes = key.length - rem;
  let h1: U64 = [0, seed];
  let h2: U64 = [0, seed];
  let k1: U64 = [0, 0];
  let k2: U64 = [0, 0];
  const c1: U64 = [2277735313, 289559509];
  const c2: U64 = [1291169091, 658871167];
  const c = (i: number) => key.charCodeAt(i);
  let i = 0;
  for (; i < bytes; i += 16) {
    k1 = [
      (c(i + 4) & 255) | ((c(i + 5) & 255) << 8) | ((c(i + 6) & 255) << 16) | ((c(i + 7) & 255) << 24),
      (c(i) & 255) | ((c(i + 1) & 255) << 8) | ((c(i + 2) & 255) << 16) | ((c(i + 3) & 255) << 24),
    ];
    k2 = [
      (c(i + 12) & 255) | ((c(i + 13) & 255) << 8) | ((c(i + 14) & 255) << 16) | ((c(i + 15) & 255) << 24),
      (c(i + 8) & 255) | ((c(i + 9) & 255) << 8) | ((c(i + 10) & 255) << 16) | ((c(i + 11) & 255) << 24),
    ];
    k1 = mul(k1, c1); k1 = rotl(k1, 31); k1 = mul(k1, c2); h1 = xor(h1, k1);
    h1 = rotl(h1, 27); h1 = add(h1, h2); h1 = add(mul(h1, [0, 5]), [0, 1390208809]);
    k2 = mul(k2, c2); k2 = rotl(k2, 33); k2 = mul(k2, c1); h2 = xor(h2, k2);
    h2 = rotl(h2, 31); h2 = add(h2, h1); h2 = add(mul(h2, [0, 5]), [0, 944331445]);
  }
  k1 = [0, 0];
  k2 = [0, 0];
  // Tail: same fallthrough as the original switch(n){case 15..case 1}.
  if (rem >= 15) k2 = xor(k2, shl([0, c(i + 14)], 48));
  if (rem >= 14) k2 = xor(k2, shl([0, c(i + 13)], 40));
  if (rem >= 13) k2 = xor(k2, shl([0, c(i + 12)], 32));
  if (rem >= 12) k2 = xor(k2, shl([0, c(i + 11)], 24));
  if (rem >= 11) k2 = xor(k2, shl([0, c(i + 10)], 16));
  if (rem >= 10) k2 = xor(k2, shl([0, c(i + 9)], 8));
  if (rem >= 9) {
    k2 = xor(k2, [0, c(i + 8)]);
    k2 = mul(k2, c2); k2 = rotl(k2, 33); k2 = mul(k2, c1); h2 = xor(h2, k2);
  }
  if (rem >= 8) k1 = xor(k1, shl([0, c(i + 7)], 56));
  if (rem >= 7) k1 = xor(k1, shl([0, c(i + 6)], 48));
  if (rem >= 6) k1 = xor(k1, shl([0, c(i + 5)], 40));
  if (rem >= 5) k1 = xor(k1, shl([0, c(i + 4)], 32));
  if (rem >= 4) k1 = xor(k1, shl([0, c(i + 3)], 24));
  if (rem >= 3) k1 = xor(k1, shl([0, c(i + 2)], 16));
  if (rem >= 2) k1 = xor(k1, shl([0, c(i + 1)], 8));
  if (rem >= 1) {
    k1 = xor(k1, [0, c(i)]);
    k1 = mul(k1, c1); k1 = rotl(k1, 31); k1 = mul(k1, c2); h1 = xor(h1, k1);
  }
  h1 = xor(h1, [0, key.length]);
  h2 = xor(h2, [0, key.length]);
  h1 = add(h1, h2); h2 = add(h2, h1);
  h1 = fmix(h1); h2 = fmix(h2);
  h1 = add(h1, h2); h2 = add(h2, h1);
  return hex8(h1[0]) + hex8(h1[1]) + hex8(h2[0]) + hex8(h2[1]);
}
