// ======================================================
// Python 兼容 Mersenne Twister (MT19937) + random.seed(str)
// 与 Python 端 random.shuffle 完全一致，保证解密结果正确
// ======================================================

export class MT19937 {
  N = 624;
  M = 397;
  mt = new Uint32Array(this.N);
  mti = this.N + 1;

  init_genrand(s: number) {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < this.N; i++) {
      this.mt[i] = (Math.imul(this.mt[i - 1] ^ (this.mt[i - 1] >>> 30), 1812433253) + i) >>> 0;
    }
    this.mti = this.N;
  }

  init_by_array(key: number[]) {
    this.init_genrand(19650218);
    let i = 1,
      j = 0,
      k = Math.max(this.N, key.length);
    for (; k > 0; k--) {
      const s = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = ((this.mt[i] ^ Math.imul(s, 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= this.N) {
        this.mt[0] = this.mt[this.N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (k = this.N - 1; k > 0; k--) {
      const s = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = ((this.mt[i] ^ Math.imul(s, 1566083941)) - i) >>> 0;
      i++;
      if (i >= this.N) {
        this.mt[0] = this.mt[this.N - 1];
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  genrand_int32(): number {
    let y: number;
    const m = [0, 0x9908b0df];
    if (this.mti >= this.N) {
      let kk;
      for (kk = 0; kk < this.N - this.M; kk++) {
        y = (this.mt[kk] & 0x80000000) | (this.mt[kk + 1] & 0x7fffffff);
        this.mt[kk] = (this.mt[kk + this.M] ^ (y >>> 1) ^ m[y & 1]) >>> 0;
      }
      for (; kk < this.N - 1; kk++) {
        y = (this.mt[kk] & 0x80000000) | (this.mt[kk + 1] & 0x7fffffff);
        this.mt[kk] = (this.mt[kk + (this.M - this.N)] ^ (y >>> 1) ^ m[y & 1]) >>> 0;
      }
      y = (this.mt[this.N - 1] & 0x80000000) | (this.mt[0] & 0x7fffffff);
      this.mt[this.N - 1] = (this.mt[this.M - 1] ^ (y >>> 1) ^ m[y & 1]) >>> 0;
      this.mti = 0;
    }
    y = this.mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

export class PyRandom {
  mt = new MT19937();

  async seed(pw: string) {
    const enc = new TextEncoder();
    const pb = enc.encode(pw);
    const hb = new Uint8Array(await crypto.subtle.digest('SHA-512', pb));
    const cb = new Uint8Array(pb.length + hb.length);
    cb.set(pb);
    cb.set(hb, pb.length);
    let bi = 0n;
    for (const b of cb) bi = (bi << 8n) | BigInt(b);
    const w: number[] = [];
    let t = bi;
    while (t > 0n) {
      w.push(Number(t & 0xffffffffn));
      t >>= 32n;
    }
    if (!w.length) w.push(0);
    this.mt.init_by_array(w);
  }

  getrandbits(k: number): number {
    return k <= 0 ? 0 : this.mt.genrand_int32() >>> (32 - k);
  }

  _randbelow(n: number): number {
    if (n <= 1) return 0;
    const k = 32 - Math.clz32(n);
    while (true) {
      const r = this.getrandbits(k);
      if (r < n) return r;
    }
  }

  shuffle(a: number[]) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = this._randbelow(i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
  }
}

/** 计算块置换的逆映射（解密用）。返回 inv，其中 inv[shuffledIndex] = originalIndex */
export async function computeInverseMap(pw: string, numBlocks: number): Promise<Int32Array> {
  const rng = new PyRandom();
  await rng.seed(pw);
  const si = Array.from({ length: numBlocks }, (_, i) => i);
  rng.shuffle(si);
  const inv = new Int32Array(numBlocks);
  for (let o = 0; o < numBlocks; o++) inv[si[o]] = o;
  return inv;
}
