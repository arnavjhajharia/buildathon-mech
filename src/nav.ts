// Coarse 4 m walkability grid and distance fields (Dial's algorithm, 8-neighbour) for ground navigation.
import type { World } from "./world.ts"

export class Nav {
  S = 4
  gw: number; gh: number; ox: number; oy: number
  walk: Uint8Array
  gz: Float32Array // ground height per cell centre

  w: World
  constructor(w: World) {
    this.w = w
    const S = this.S
    this.ox = w.bounds.minX; this.oy = w.bounds.minY
    this.gw = Math.ceil((w.bounds.maxX - w.bounds.minX) / S)
    this.gh = Math.ceil((w.bounds.maxY - w.bounds.minY) / S)
    const n = this.gw * this.gh
    this.walk = new Uint8Array(n)
    this.gz = new Float32Array(n)
    for (let j = 0; j < this.gh; j++) for (let i = 0; i < this.gw; i++) {
      const cx = this.ox + (i + 0.5) * S, cy = this.oy + (j + 0.5) * S
      const g = w.ground(cx, cy)
      this.gz[j * this.gw + i] = g
      let ok = i > 6 && j > 6 && i < this.gw - 7 && j < this.gh - 7
      let lo = 1e9, hi = -1e9
      for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = cx + dx, y = cy + dy
        const gg = w.ground(x, y)
        if (gg < lo) lo = gg
        if (gg > hi) hi = gg
        if (w.spanBlocked(x, y, gg + 1.2, gg + 9)) { ok = false; break }
      }
      if (hi - lo > 5) ok = false
      this.walk[j * this.gw + i] = ok ? 1 : 0
    }
    // connected components (4-neighbour); main = largest
    this.comp = new Int32Array(n).fill(-1)
    let bestSize = 0
    for (let s = 0, id = 0; s < n; s++) {
      if (!this.walk[s] || this.comp[s] >= 0) continue
      let cnt = 0
      const st = [s]
      this.comp[s] = id
      while (st.length) {
        const c = st.pop()!
        cnt++
        const i = c % this.gw, j = (c - i) / this.gw
        if (i > 0 && this.walk[c - 1] && this.comp[c - 1] < 0) { this.comp[c - 1] = id; st.push(c - 1) }
        if (i < this.gw - 1 && this.walk[c + 1] && this.comp[c + 1] < 0) { this.comp[c + 1] = id; st.push(c + 1) }
        if (j > 0 && this.walk[c - this.gw] && this.comp[c - this.gw] < 0) { this.comp[c - this.gw] = id; st.push(c - this.gw) }
        if (j < this.gh - 1 && this.walk[c + this.gw] && this.comp[c + this.gw] < 0) { this.comp[c + this.gw] = id; st.push(c + this.gw) }
      }
      if (cnt > bestSize) { bestSize = cnt; this.mainComp = id }
      id++
    }
  }
  comp: Int32Array
  hC: Int32Array | null = null
  hD: Float32Array | null = null
  mainComp = 0

  /** Nearest cell of the main walkable component (spiral search up to r cells). */
  nearestMain(x: number, y: number, r = 25): number {
    const c0 = this.idx(x, y)
    if (this.comp[c0] === this.mainComp) return c0
    const i0 = c0 % this.gw, j0 = Math.floor(c0 / this.gw)
    for (let rr = 1; rr <= r; rr++) {
      let best = -1, bd = 1e9
      for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== rr) continue
        const i = i0 + di, j = j0 + dj
        if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) continue
        const c = j * this.gw + i
        if (this.comp[c] !== this.mainComp) continue
        const d = di * di + dj * dj
        if (d < bd) { bd = d; best = c }
      }
      if (best >= 0) return best
    }
    return -1
  }

  idx(x: number, y: number): number {
    let i = Math.floor((x - this.ox) / this.S), j = Math.floor((y - this.oy) / this.S)
    if (i < 0) i = 0; else if (i >= this.gw) i = this.gw - 1
    if (j < 0) j = 0; else if (j >= this.gh) j = this.gh - 1
    return j * this.gw + i
  }
  cx(c: number) { return this.ox + ((c % this.gw) + 0.5) * this.S }
  cy(c: number) { return this.oy + (Math.floor(c / this.gw) + 0.5) * this.S }

  /** Nearest walkable cell to (x,y) within r cells, or -1. */
  nearestWalk(x: number, y: number, r = 6): number {
    const c0 = this.idx(x, y)
    if (this.walk[c0]) return c0
    const i0 = c0 % this.gw, j0 = Math.floor(c0 / this.gw)
    let best = -1, bd = 1e9
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = i0 + di, j = j0 + dj
      if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) continue
      const c = j * this.gw + i
      if (!this.walk[c]) continue
      const d = di * di + dj * dj
      if (d < bd) { bd = d; best = c }
    }
    return best
  }

  /**
   * Distance field (in metres*~1) from goal cells. extraCost (optional) adds per-cell cost (e.g. danger).
   * Unreachable = 1e9. maxCost stops early.
   */
  field(goals: number[], extraCost?: Float32Array, maxCost = 1e9, out?: Float32Array): Float32Array {
    const n = this.gw * this.gh
    const dist = out && out.length === n ? out : new Float32Array(n)
    dist.fill(1e9)
    // Dijkstra with a binary heap on float costs (preallocated typed arrays: no garbage per call).
    if (!this.hC || this.hC.length < n * 4) { this.hC = new Int32Array(n * 4); this.hD = new Float32Array(n * 4) }
    const hC = this.hC, hD = this.hD!
    let hn = 0
    const push = (c: number, d: number) => {
      if (hn >= hC.length) return
      let k = hn++
      while (k > 0) {
        const p = (k - 1) >> 1
        if (hD[p] <= d) break
        hC[k] = hC[p]; hD[k] = hD[p]; k = p
      }
      hC[k] = c; hD[k] = d
    }
    const pop = () => {
      const c = hC[0], d = hD[0]
      hn--
      const lc = hC[hn], ld = hD[hn]
      const m = hn
      if (m > 0) {
        let k = 0
        while (true) {
          let a = 2 * k + 1
          if (a >= m) break
          if (a + 1 < m && hD[a + 1] < hD[a]) a++
          if (hD[a] >= ld) break
          hC[k] = hC[a]; hD[k] = hD[a]; k = a
        }
        hC[k] = lc; hD[k] = ld
      }
      popD = d
      return c
    }
    let popD = 0
    for (const g of goals) if (g >= 0) { dist[g] = 0; push(g, 0) }
    const gw = this.gw, gh = this.gh, S = this.S, D = S * Math.SQRT2
    const walk = this.walk
    while (hn > 0) {
      const c = pop()
      const d = popD
      if (d > dist[c]) continue
      if (d > maxCost) break
      const i = c % gw, j = (c - i) / gw
      for (let k = 0; k < 8; k++) {
        const di = k === 0 ? 1 : k === 1 ? -1 : k === 2 ? 0 : k === 3 ? 0 : k === 4 ? 1 : k === 5 ? 1 : k === 6 ? -1 : -1
        const dj = k === 0 ? 0 : k === 1 ? 0 : k === 2 ? 1 : k === 3 ? -1 : k === 4 ? 1 : k === 5 ? -1 : k === 6 ? 1 : -1
        const ii = i + di, jj = j + dj
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue
        const nc = jj * gw + ii
        if (!walk[nc]) continue
        if (k >= 4 && (!walk[j * gw + ii] || !walk[jj * gw + i])) continue
        let nd = d + (k >= 4 ? D : S)
        if (extraCost) nd += extraCost[nc]
        nd = Math.fround(nd) // costs live in a Float32Array: compare and queue the same rounded value
        if (nd < dist[nc]) { dist[nc] = nd; push(nc, nd) }
      }
    }
    return dist
  }

  /** Steepest-descent direction on a field from (x,y). Returns [dx,dy] unit or null. */
  descend(dist: Float32Array, x: number, y: number): [number, number] | null {
    let c = this.idx(x, y)
    if (!this.walk[c] || dist[c] >= 1e9) {
      const nw = this.nearestWalk(x, y, 4)
      if (nw < 0) return null
      if (dist[nw] >= 1e9) return null
      const dx = this.cx(nw) - x, dy = this.cy(nw) - y, l = Math.hypot(dx, dy) || 1
      return [dx / l, dy / l]
    }
    // look two steps ahead for smoother paths
    let best = c, bd = dist[c]
    const gw = this.gw
    for (let step = 0; step < 3; step++) {
      const i = best % gw, j = Math.floor(best / gw)
      let nb = best
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj
        if (ii < 0 || jj < 0 || ii >= gw || jj >= this.gh) continue
        const nc = jj * gw + ii
        if (dist[nc] < bd) { bd = dist[nc]; nb = nc }
      }
      if (nb === best) break
      best = nb
    }
    if (best === c) return null
    const dx = this.cx(best) - x, dy = this.cy(best) - y, l = Math.hypot(dx, dy) || 1
    return [dx / l, dy / l]
  }
}
