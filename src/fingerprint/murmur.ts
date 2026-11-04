// Literal port of Fingerprint2 v1.8.0's x64hash128 (MurmurHash3 x64 128-bit) as embedded in
// game.php's <script id="fp-script">. 64-bit words are [hi, lo] pairs of 32-bit ints, exactly as in
// the original, so quirks are reproduced bit-for-bit. Note the body loop masks charCodeAt with 255,
// while the tail switch does NOT (chars > 0xFF leak extra bits there).

type U64 = [number, number];
/** A U64 split into four 16-bit limbs, high first. */
type Limbs = [number, number, number, number];

function add(first: U64, second: U64): U64 {
  const entry: Limbs = [first[0] >>> 16, first[0] & 0xffff, first[1] >>> 16, first[1] & 0xffff];
  const target: Limbs = [second[0] >>> 16, second[0] & 0xffff, second[1] >>> 16, second[1] & 0xffff];
  const count: Limbs = [0, 0, 0, 0];
  count[3] += entry[3] + target[3];
  count[2] += count[3] >>> 16;
  count[3] &= 0xffff;
  count[2] += entry[2] + target[2];
  count[1] += count[2] >>> 16;
  count[2] &= 0xffff;
  count[1] += entry[1] + target[1];
  count[0] += count[1] >>> 16;
  count[1] &= 0xffff;
  count[0] += entry[0] + target[0];
  count[0] &= 0xffff;
  return [(count[0] << 16) | count[1], (count[2] << 16) | count[3]];
}

function mul(first: U64, second: U64): U64 {
  const entry: Limbs = [first[0] >>> 16, first[0] & 0xffff, first[1] >>> 16, first[1] & 0xffff];
  const target: Limbs = [second[0] >>> 16, second[0] & 0xffff, second[1] >>> 16, second[1] & 0xffff];
  const count: Limbs = [0, 0, 0, 0];
  count[3] += entry[3] * target[3];
  count[2] += count[3] >>> 16;
  count[3] &= 0xffff;
  count[2] += entry[2] * target[3];
  count[1] += count[2] >>> 16;
  count[2] &= 0xffff;
  count[2] += entry[3] * target[2];
  count[1] += count[2] >>> 16;
  count[2] &= 0xffff;
  count[1] += entry[1] * target[3];
  count[0] += count[1] >>> 16;
  count[1] &= 0xffff;
  count[1] += entry[2] * target[2];
  count[0] += count[1] >>> 16;
  count[1] &= 0xffff;
  count[1] += entry[3] * target[1];
  count[0] += count[1] >>> 16;
  count[1] &= 0xffff;
  count[0] += entry[0] * target[3] + entry[1] * target[2] + entry[2] * target[1] + entry[3] * target[0];
  count[0] &= 0xffff;
  return [(count[0] << 16) | count[1], (count[2] << 16) | count[3]];
}

function rotl(entry: U64, time: number): U64 {
  time %= 64;
  if (time === 32) {
    return [entry[1], entry[0]];
  }
  if (time < 32) {
    return [(entry[0] << time) | (entry[1] >>> (32 - time)), (entry[1] << time) | (entry[0] >>> (32 - time))];
  }
  time -= 32;
  return [(entry[1] << time) | (entry[0] >>> (32 - time)), (entry[0] << time) | (entry[1] >>> (32 - time))];
}

function shl(entry: U64, time: number): U64 {
  time %= 64;
  if (time === 0) {
    return entry;
  }
  if (time < 32) {
    return [(entry[0] << time) | (entry[1] >>> (32 - time)), entry[1] << time];
  }
  return [entry[1] << (time - 32), 0];
}

const xor = (first: U64, second: U64): U64 => [first[0] ^ second[0], first[1] ^ second[1]];

function fmix(entry: U64): U64 {
  entry = xor(entry, [0, entry[0] >>> 1]);
  entry = mul(entry, [4283543511, 3981806797]);
  entry = xor(entry, [0, entry[0] >>> 1]);
  entry = mul(entry, [3301882366, 444984403]);
  entry = xor(entry, [0, entry[0] >>> 1]);
  return entry;
}

const hex8 = (count: number) => `00000000${(count >>> 0).toString(16)}`.slice(-8);

export function x64hash128(key: string, seed = 0): string {
  key = key || '';
  const rem = key.length % 16;
  const bytes = key.length - rem;
  let hash1: U64 = [0, seed];
  let hash2: U64 = [0, seed];
  let keyWord1: U64 = [0, 0];
  let keyWord2: U64 = [0, 0];
  const constant1: U64 = [2277735313, 289559509];
  const constant2: U64 = [1291169091, 658871167];
  const transform = (characterIndex: number) => key.charCodeAt(characterIndex);
  let index = 0;
  for (; index < bytes; index += 16) {
    keyWord1 = [
      (transform(index + 4) & 255) |
        ((transform(index + 5) & 255) << 8) |
        ((transform(index + 6) & 255) << 16) |
        ((transform(index + 7) & 255) << 24),
      (transform(index) & 255) |
        ((transform(index + 1) & 255) << 8) |
        ((transform(index + 2) & 255) << 16) |
        ((transform(index + 3) & 255) << 24),
    ];
    keyWord2 = [
      (transform(index + 12) & 255) |
        ((transform(index + 13) & 255) << 8) |
        ((transform(index + 14) & 255) << 16) |
        ((transform(index + 15) & 255) << 24),
      (transform(index + 8) & 255) |
        ((transform(index + 9) & 255) << 8) |
        ((transform(index + 10) & 255) << 16) |
        ((transform(index + 11) & 255) << 24),
    ];
    keyWord1 = mul(keyWord1, constant1);
    keyWord1 = rotl(keyWord1, 31);
    keyWord1 = mul(keyWord1, constant2);
    hash1 = xor(hash1, keyWord1);
    hash1 = rotl(hash1, 27);
    hash1 = add(hash1, hash2);
    hash1 = add(mul(hash1, [0, 5]), [0, 1390208809]);
    keyWord2 = mul(keyWord2, constant2);
    keyWord2 = rotl(keyWord2, 33);
    keyWord2 = mul(keyWord2, constant1);
    hash2 = xor(hash2, keyWord2);
    hash2 = rotl(hash2, 31);
    hash2 = add(hash2, hash1);
    hash2 = add(mul(hash2, [0, 5]), [0, 944331445]);
  }
  keyWord1 = [0, 0];
  keyWord2 = [0, 0];
  // Tail: same fallthrough as the original switch(n){case 15..case 1}.
  if (rem >= 15) {
    keyWord2 = xor(keyWord2, shl([0, transform(index + 14)], 48));
  }
  if (rem >= 14) {
    keyWord2 = xor(keyWord2, shl([0, transform(index + 13)], 40));
  }
  if (rem >= 13) {
    keyWord2 = xor(keyWord2, shl([0, transform(index + 12)], 32));
  }
  if (rem >= 12) {
    keyWord2 = xor(keyWord2, shl([0, transform(index + 11)], 24));
  }
  if (rem >= 11) {
    keyWord2 = xor(keyWord2, shl([0, transform(index + 10)], 16));
  }
  if (rem >= 10) {
    keyWord2 = xor(keyWord2, shl([0, transform(index + 9)], 8));
  }
  if (rem >= 9) {
    keyWord2 = xor(keyWord2, [0, transform(index + 8)]);
    keyWord2 = mul(keyWord2, constant2);
    keyWord2 = rotl(keyWord2, 33);
    keyWord2 = mul(keyWord2, constant1);
    hash2 = xor(hash2, keyWord2);
  }
  if (rem >= 8) {
    keyWord1 = xor(keyWord1, shl([0, transform(index + 7)], 56));
  }
  if (rem >= 7) {
    keyWord1 = xor(keyWord1, shl([0, transform(index + 6)], 48));
  }
  if (rem >= 6) {
    keyWord1 = xor(keyWord1, shl([0, transform(index + 5)], 40));
  }
  if (rem >= 5) {
    keyWord1 = xor(keyWord1, shl([0, transform(index + 4)], 32));
  }
  if (rem >= 4) {
    keyWord1 = xor(keyWord1, shl([0, transform(index + 3)], 24));
  }
  if (rem >= 3) {
    keyWord1 = xor(keyWord1, shl([0, transform(index + 2)], 16));
  }
  if (rem >= 2) {
    keyWord1 = xor(keyWord1, shl([0, transform(index + 1)], 8));
  }
  if (rem >= 1) {
    keyWord1 = xor(keyWord1, [0, transform(index)]);
    keyWord1 = mul(keyWord1, constant1);
    keyWord1 = rotl(keyWord1, 31);
    keyWord1 = mul(keyWord1, constant2);
    hash1 = xor(hash1, keyWord1);
  }
  hash1 = xor(hash1, [0, key.length]);
  hash2 = xor(hash2, [0, key.length]);
  hash1 = add(hash1, hash2);
  hash2 = add(hash2, hash1);
  hash1 = fmix(hash1);
  hash2 = fmix(hash2);
  hash1 = add(hash1, hash2);
  hash2 = add(hash2, hash1);
  return hex8(hash1[0]) + hex8(hash1[1]) + hex8(hash2[0]) + hex8(hash2[1]);
}
