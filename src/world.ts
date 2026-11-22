// Static map model for mechfight/1 (protocol.md section 11): terrain heights, prisms rasterized to a 1 m grid,
// line-of-sight and shot ray tests, standing height. Used by the bot and by the local test arena.
import { readFileSync } from "node:fs"

const NONE_TOP = -1e9
const NONE_BASE = 1e9

export class World {
  minX: number; minY: number; nx: number; ny: number
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  terr: Float32Array       // ground height per vertex
  bTop: Float32Array       // building/stadium solid top per 1 m cell (NONE_TOP when empty)
  bBase: Float32Array
  rTop: Float32Array       // bridge solid
  rBase: Float32Array
  maxTop: Float32Array     // max solid/terrain top per cell (quick reject for rays)
  // trees: vision only
  tx: Float32Array; ty: Float32Array; tz: Float32Array; th: Float32Array
  tcx: Float32Array; tcy: Float32Array; tcr: Float32Array; tcb: Float32Array; ttr: Float32Array
  tGrid: Int32Array[]; tgN: number; tgM: number; tgS = 10
  tStamp: Int32Array; stamp = 1
  canopyDensity: number; canopyBlockT: number

  constructor(mapDir: string) {
    const w = JSON.parse(readFileSync(mapDir + "/v2/world.json", "utf8"))
    const T = w.terrain
    this.minX = T.minX; this.minY = T.minY; this.nx = T.nx; this.ny = T.ny
    this.bounds = w.bounds
    const raw = readFileSync(mapDir + "/v2/terrain.i16")
    const n = T.nx * T.ny
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    this.terr = new Float32Array(n)
    for (let i = 0; i < n; i++) this.terr[i] = dv.getInt16(i * 2, true) * (T.scale ?? 0.01)
    this.bTop = new Float32Array(n).fill(NONE_TOP)
    this.bBase = new Float32Array(n).fill(NONE_BASE)
    this.rTop = new Float32Array(n).fill(NONE_TOP)
    this.rBase = new Float32Array(n).fill(NONE_BASE)
    for (const p of w.prisms) this.raster(p)
    this.maxTop = new Float32Array(n)
    for (let i = 0; i < n; i++) this.maxTop[i] = Math.max(this.terr[i], this.bTop[i], this.rTop[i])
    // trees
    const F = w.trees.fields as string[]
    const D = w.trees.data as number[]
    const k = F.length, nt = Math.floor(D.length / k)
    const col = (name: string) => F.indexOf(name)
    const ix = col("x"), iy = col("y"), iz = col("z"), ih = col("height"), icr = col("crownR"), icb = col("crownBase"),
      itr = col("trunkR"), icx = col("crownX"), icy = col("crownY")
    this.tx = new Float32Array(nt); this.ty = new Float32Array(nt); this.tz = new Float32Array(nt); this.th = new Float32Array(nt)
    this.tcx = new Float32Array(nt); this.tcy = new Float32Array(nt); this.tcr = new Float32Array(nt); this.tcb = new Float32Array(nt)
    this.ttr = new Float32Array(nt)
    for (let i = 0; i < nt; i++) {
      const o = i * k
      this.tx[i] = D[o + ix]; this.ty[i] = D[o + iy]; this.tz[i] = D[o + iz]; this.th[i] = D[o + ih]
      this.tcr[i] = D[o + icr]; this.tcb[i] = D[o + icb]; this.ttr[i] = D[o + itr]
      this.tcx[i] = icx >= 0 ? D[o + icx] : D[o + ix]; this.tcy[i] = icy >= 0 ? D[o + icy] : D[o + iy]
    }
    this.tgN = Math.ceil(this.nx / this.tgS) + 1; this.tgM = Math.ceil(this.ny / this.tgS) + 1
    const lists: number[][] = []
    for (let i = 0; i < this.tgN * this.tgM; i++) lists.push([])
    for (let i = 0; i < nt; i++) {
      const r = Math.max(this.tcr[i], this.ttr[i]) + 0.5
      const cx = this.tcx[i], cy = this.tcy[i]
      const x0 = Math.floor((Math.min(cx, this.tx[i]) - r - this.minX) / this.tgS), x1 = Math.floor((Math.max(cx, this.tx[i]) + r - this.minX) / this.tgS)
      const y0 = Math.floor((Math.min(cy, this.ty[i]) - r - this.minY) / this.tgS), y1 = Math.floor((Math.max(cy, this.ty[i]) + r - this.minY) / this.tgS)
      for (let gy = Math.max(0, y0); gy <= Math.min(this.tgM - 1, y1); gy++)
        for (let gx = Math.max(0, x0); gx <= Math.min(this.tgN - 1, x1); gx++) lists[gy * this.tgN + gx].push(i)
    }
    this.tGrid = lists.map((l) => Int32Array.from(l))
    this.tStamp = new Int32Array(nt)
    this.canopyDensity = w.rules?.canopyDensity ?? 0.35
    this.canopyBlockT = w.rules?.canopyBlockT ?? 0.25
  }

  raster(p: any) {
    const edges: number[] = []
    const addRing = (r: number[]) => {
      const m = r.length / 2
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m
        edges.push(r[i * 2], r[i * 2 + 1], r[j * 2], r[j * 2 + 1])
      }
    }
    addRing(p.ring)
    for (const h of p.holes || []) addRing(h)
    let y0 = 1e9, y1 = -1e9
    for (let i = 1; i < p.ring.length; i += 2) { y0 = Math.min(y0, p.ring[i]); y1 = Math.max(y1, p.ring[i]) }
    const bridge = p.kind === "bridge"
    const top = bridge ? this.rTop : this.bTop, base = bridge ? this.rBase : this.bBase
    const j0 = Math.max(0, Math.floor(y0 - this.minY - 0.5)), j1 = Math.min(this.ny - 1, Math.ceil(y1 - this.minY))
    const xs: number[] = []
    for (let j = j0; j <= j1; j++) {
      const yc = this.minY + j + 0.5
      xs.length = 0
      for (let e = 0; e < edges.length; e += 4) {
        const ay = edges[e + 1], by = edges[e + 3]
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          const ax = edges[e], bx = edges[e + 2]
          xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax))
        }
      }
      xs.sort((a, b) => a - b)
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil(xs[q] - this.minX - 0.5)), i1 = Math.min(this.nx - 1, Math.floor(xs[q + 1] - this.minX - 0.5))
        for (let i = i0; i <= i1; i++) {
          const c = j * this.nx + i
          if (p.top > top[c]) top[c] = p.top
          if (p.base < base[c]) base[c] = p.base
        }
      }
    }
  }

  cell(x: number, y: number): number {
    let i = Math.floor(x - this.minX), j = Math.floor(y - this.minY)
    if (i < 0) i = 0; else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0; else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }

  /** Bilinear terrain height (protocol section 11). */
  ground(x: number, y: number): number {
    let fx = x - this.minX, fy = y - this.minY
    if (fx < 0) fx = 0; else if (fx > this.nx - 1.001) fx = this.nx - 1.001
    if (fy < 0) fy = 0; else if (fy > this.ny - 1.001) fy = this.ny - 1.001
    const i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j
    const o = j * this.nx + i, t = this.terr
    return (t[o] * (1 - ax) + t[o + 1] * ax) * (1 - ay) + (t[o + this.nx] * (1 - ax) + t[o + this.nx + 1] * ax) * ay
  }

  /** True if (x,y,z) is inside a prism or below terrain. */
  solid(x: number, y: number, z: number): boolean {
    const c = this.cell(x, y)
    if (z < this.terr[c] - 0.3 && z < this.ground(x, y)) return true
    return (z >= this.bBase[c] && z < this.bTop[c]) || (z >= this.rBase[c] && z < this.rTop[c])
  }

  /** Highest surface at (x,y) whose top is at or below zMax: terrain, roof or bridge deck. */
  surfaceBelow(x: number, y: number, zMax: number): number {
    const c = this.cell(x, y)
    let s = this.ground(x, y)
    const bt = this.bTop[c]
    if (bt > s && bt <= zMax) s = bt
    const rt = this.rTop[c]
    if (rt > s && rt <= zMax) s = rt
    return s
  }

  /** True if the vertical span (z0, z1) at column (x,y) intersects solid (prisms or terrain above z0). */
  spanBlocked(x: number, y: number, z0: number, z1: number): boolean {
    const c = this.cell(x, y)
    if (this.maxTop[c] <= z0) return false
    if (this.ground(x, y) > z0) return true
    if (this.bTop[c] > z0 && this.bBase[c] < z1) return true
    if (this.rTop[c] > z0 && this.rBase[c] < z1) return true
    return false
  }

  /** Roof/obstacle top at (x,y) (max of building and bridge tops), or terrain if none. */
  topAt(x: number, y: number): number {
    return this.maxTop[this.cell(x, y)]
  }

  isBuilding(x: number, y: number): boolean {
    const c = this.cell(x, y)
    return this.bTop[c] > NONE_TOP
  }

  /**
   * First solid hit along segment a->b, as a fraction in [0,1], or 1 if clear.
   * Buildings, bridges and terrain block; trees do not (shots).
   */
  rayFrac(ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 0.5): number {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const n = Math.ceil(L / step)
    if (n <= 0) return 1
    const nx = this.nx, mx = this.minX, my = this.minY
    for (let s = 1; s <= n; s++) {
      const f = s / n
      const x = ax + dx * f, y = ay + dy * f, z = az + dz * f
      let i = Math.floor(x - mx), j = Math.floor(y - my)
      if (i < 0 || j < 0 || i >= nx || j >= this.ny) return f
      const c = j * nx + i
      if (z >= this.maxTop[c]) continue
      if (z < this.terr[c] && z < this.ground(x, y)) return (s - 1) / n
      if ((z >= this.bBase[c] && z < this.bTop[c]) || (z >= this.rBase[c] && z < this.rTop[c])) return (s - 1) / n
    }
    return 1
  }

  /** Line of sight for vision. trees=true adds trunks and canopy density (protocol section 8). */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, trees = true): boolean {
    if (this.rayFrac(ax, ay, az, bx, by, bz, 0.7) < 1) return false
    if (!trees) return true
    return this.treeClear(ax, ay, az, bx, by, bz)
  }

  treeClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L2 = dx * dx + dy * dy
    const L = Math.sqrt(L2)
    if (L < 0.01) return true
    this.stamp++
    const S = this.tgS
    const steps = Math.ceil(L / (S * 0.5)) + 1
    let crown = 0
    const lim = Math.log(1 / this.canopyBlockT) / this.canopyDensity
    let lastCell = -1
    for (let s = 0; s <= steps; s++) {
      const f = s / steps
      const gx = Math.floor((ax + dx * f - this.minX) / S), gy = Math.floor((ay + dy * f - this.minY) / S)
      if (gx < 0 || gy < 0 || gx >= this.tgN || gy >= this.tgM) continue
      const gc = gy * this.tgN + gx
      if (gc === lastCell) continue
      lastCell = gc
      const list = this.tGrid[gc]
      for (let q = 0; q < list.length; q++) {
        const t = list[q]
        if (this.tStamp[t] === this.stamp) continue
        this.tStamp[t] = this.stamp
        // trunk
        {
          const px = this.tx[t] - ax, py = this.ty[t] - ay
          let u = (px * dx + py * dy) / L2
          if (u > 0 && u < 1) {
            const cx = px - dx * u, cy = py - dy * u
            const r = this.ttr[t]
            if (cx * cx + cy * cy < r * r) {
              const z = az + dz * u
              if (z >= this.tz[t] && z <= this.tz[t] + this.tcb[t] + 0.5) return false
            }
          }
        }
        // crown: vertical cylinder from crownBase to height
        const px = this.tcx[t] - ax, py = this.tcy[t] - ay
        const u = (px * dx + py * dy) / L2
        const cx = px - dx * Math.max(0, Math.min(1, u)), cy = py - dy * Math.max(0, Math.min(1, u))
        const d2 = cx * cx + cy * cy, r = this.tcr[t]
        if (d2 < r * r) {
          const z = az + dz * Math.max(0, Math.min(1, u))
          if (z >= this.tz[t] + this.tcb[t] && z <= this.tz[t] + this.th[t]) {
            crown += 2 * Math.sqrt(r * r - d2)
            if (crown > lim) return false
          }
        }
      }
    }
    return true
  }
}

let cached: World | null = null
/** Load once per process. */
export function loadWorld(mapDir: string): World {
  if (!cached) cached = new World(mapDir)
  return cached
}
