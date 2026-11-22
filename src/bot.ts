// Mech bot for mechfight/1. States: ZONE (get inside), FIGHT (target in sight and worth fighting),
// COVER (break line of sight and regenerate), FARM (drones/crates from range for cubes), LOOT, HOLD.
import { loadWorld, type World } from "./world.ts"
import { Nav } from "./nav.ts"

type V3 = [number, number, number]
const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
const hyp = (x: number, y: number) => Math.sqrt(x * x + y * y)

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const PARAMS = {
  retreatHp: 0.4,        // go to cover below this HP fraction (scaled up when outnumbered)
  reengageHp: 0.8,       // leave cover once healed to this fraction (if not pressed)
  farmNpc: true,
  farmCrates: true,
  npcStandoff: 60,       // stay at least this far from drones we farm (aggro 45)
  zoneMargin: 0.3,       // fraction of next radius to keep as margin
  jink: true,
  takeDrops: false,
  gunRange: 45,
  engageHp: 0.8,         // start new fights only above this HP fraction
  farmHp: 0.9,           // farm drones/crates only above this (dealing damage stops regen)          // preferred distance for gun-only fights (short flight time beats jinking)
  lootFightR: 45,        // grab loot within this radius even while fighting
  jinkBoostE: 60,
}

const UPGRADE_PRIORITY = [
  "plating", "armor", "nanites", "laser_damage", "laser_charge", "gun_damage", "gun_rate", "gun_mag",
  "servos", "gyros", "gun_velocity", "jets", "capacitor", "reactor", "lightning_efficiency",
  "lightning_range", "sensors", "lightning_chain", "laser_pierce", "mortar_reload", "mortar_velocity", "mortar_splash",
]
const WEAPON_RANK: Record<string, number> = { laser: 3, lightning: 2, mortar: 0.5, gun: 0 }

type Enemy = { id: number; pos: V3; vel: V3; aim: [number, number]; hp: number; maxHp: number; weapons: string[]; charging: boolean; seen: number; vis: boolean; npc: boolean }

let navCache: Nav | null = null
function getNav(w: World): Nav { if (!navCache || navCache.w !== w) navCache = new Nav(w); return navCache }

export function createBot(hello: any, params: Partial<typeof PARAMS> = {}) {
  let envP: any = {}
  try { envP = typeof process !== "undefined" && process.env && process.env.MECH_PARAMS ? JSON.parse(process.env.MECH_PARAMS) : {} } catch { envP = {} }
  const P = { ...PARAMS, ...envP, ...params }
  const cfg = hello.config
  const rand = rng((hello.seed || 1) ^ 0x9e3779b9)
  let world: World | null = null
  let nav: Nav | null = null
  try {
    world = loadWorld(hello.map.dir)
    nav = getNav(world)
  } catch (e) {
    console.error("map load failed", e)
  }
  const pickupR = cfg.loot?.pickup_radius ?? 4

  const enemies = new Map<number, Enemy>()
  let lastHitT = -99, lastHitBy = -1, lastDamageT = -99
  let threatBearing: number | null = null, threatT = -99
  let jinkSide = 1, jinkUntil = 0
  let lastPos: V3 | null = null, stuckT = 0, unstickUntil = 0, unstickDir = 0
  let mode = "hold"
  let coverPt: [number, number] | null = null, coverT = -99
  let holdPt: [number, number] | null = null, holdT = -99
  let zoneField: Float32Array | null = null, zoneKey = ""
  let goalField: Float32Array | null = null, goalKey = "", goalT = -99
  let farmId = -1
  let scanPhase = rand() * TAU
  let lastT = 0
  let tAct = 0
  const dmgBy = new Map<number, number>(), dmgByT = new Map<number, number>()
  const npcAggro = new Map<number, number>()
  const recentDmg = (id: number, t: number) => (dmgBy.get(id) || 0) * Math.exp(-(t - (dmgByT.get(id) || -99)) / 3)

  // ---------- geometry helpers
  const eyeOf = (p: V3) => p[2] + 8
  const losShot = (a: V3, az: number, b: V3, bz: number) => !world || world.rayFrac(a[0], a[1], az, b[0], b[1], bz, 0.8) >= 1
  const walkable = (x: number, y: number) => {
    if (!nav) return true
    const c = nav.idx(x, y)
    return nav.comp[c] === nav.mainComp
  }

  function goTo(x: number, y: number, me: any, t: number): [number, number] {
    const dx = x - me.pos[0], dy = y - me.pos[1], d = hyp(dx, dy)
    if (d < 1) return [0, 0]
    // straight if the body path is clear, else nav field
    if (!world || !nav || d < 6 || (world.rayFrac(me.pos[0], me.pos[1], me.pos[2] + 2, x, y, world.ground(x, y) + 2, 1.0) >= 1 && d < 80)) return [dx / d, dy / d]
    const key = Math.round(x / 8) + "," + Math.round(y / 8)
    if ((key !== goalKey || t - goalT > 3) && Date.now() - tAct < 20) {
      const g = nav.nearestMain(x, y)
      if (g >= 0) { goalField = nav.field([g], undefined, d * 2.5 + 80, goalField || undefined); goalKey = key; goalT = t }
    }
    const dir = goalField ? nav.descend(goalField, me.pos[0], me.pos[1]) : null
    return dir || [dx / d, dy / d]
  }

  function zoneDir(zn: any, me: any, t: number): [number, number] | null {
    if (!nav) return null
    const key = zn.next_center[0].toFixed(1) + "," + zn.next_center[1].toFixed(1)
    if (key !== zoneKey) {
      const g = nav.nearestMain(zn.next_center[0], zn.next_center[1])
      if (g >= 0) zoneField = nav.field([g])
      zoneKey = key
    }
    return zoneField ? nav.descend(zoneField, me.pos[0], me.pos[1]) : null
  }

  // live zone circle (assumes center/radius describe the phase start circle; conservative otherwise)
  function liveZone(zn: any, t: number) {
    if (t < zn.shrink_start || zn.shrink_end <= zn.shrink_start) return { c: zn.center, r: zn.radius }
    const f = Math.min(1, (t - zn.shrink_start) / (zn.shrink_end - zn.shrink_start))
    return { c: [zn.center[0] + (zn.next_center[0] - zn.center[0]) * f, zn.center[1] + (zn.next_center[1] - zn.center[1]) * f], r: zn.radius + (zn.next_radius - zn.radius) * f }
  }
  // how safe a point is w.r.t. the zone over the next ~20 s (positive = inside with margin)
  function zoneSlack(x: number, y: number, zn: any, t: number) {
    const lz = liveZone(zn, t + 12)
    const a = lz.r - hyp(x - lz.c[0], y - lz.c[1])
    const soon = t > zn.shrink_start - 25
    const b = zn.next_radius - hyp(x - zn.next_center[0], y - zn.next_center[1])
    return soon ? Math.min(a, b) : a
  }

  // ---------- aiming
  function lead(me: any, tp: V3, tv: V3, th: number, speed: number, k = 1): [number, number, number] {
    const mh = me.stats?.muzzle_height ?? 7
    const mx = me.pos[0], my = me.pos[1], mz = me.pos[2] + mh
    let t = 0, px = tp[0], py = tp[1], pz = tp[2] + th
    for (let i = 0; i < 4; i++) {
      px = tp[0] + tv[0] * t * k; py = tp[1] + tv[1] * t * k
      pz = tp[2] + th + (Math.abs(tv[2]) > 0.5 ? tv[2] * t * k : 0)
      t = Math.sqrt((px - mx) ** 2 + (py - my) ** 2 + (pz - mz) ** 2) / speed
    }
    const dh = hyp(px - mx, py - my)
    return [Math.atan2(py - my, px - mx), Math.atan2(pz - mz, dh), dh]
  }

  // ---------- cover search: nearby walkable point with no shot line from any threat
  function findCover(me: any, threats: Enemy[], zn: any, t: number): [number, number] | null {
    if (!world) return null
    let best: [number, number] | null = null, bs = 1e9
    const [x, y] = me.pos
    for (const r of [7, 13, 20, 28, 38]) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU + r * 0.1
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r
        if (!walkable(px, py)) continue
        const gz = world.ground(px, py)
        if (Math.abs(gz - me.pos[2]) > 6) continue
        if (world.rayFrac(x, y, me.pos[2] + 2.5, px, py, gz + 2.5, 1.0) < 1) continue // must be able to walk there directly
        let exp = 0
        for (const e of threats) {
          const ez = eyeOf(e.pos)
          const mz = e.pos[2] + 7
          if (world.rayFrac(e.pos[0], e.pos[1], mz, px, py, gz + 4.5, 0.9) >= 1) exp += 1
          if (world.rayFrac(e.pos[0], e.pos[1], mz, px, py, gz + 8.5, 0.9) >= 1) exp += 0.7
          if (world.rayFrac(e.pos[0], e.pos[1], mz, px, py, gz + 1.0, 0.9) >= 1) exp += 0.3
          void ez
        }
        const zs = zoneSlack(px, py, zn, t)
        let s = exp * 100 + r * 0.8 + (zs < 0 ? -zs * 3 + 30 : 0)
        // prefer points farther from threats
        for (const e of threats) s -= Math.min(30, hyp(px - e.pos[0], py - e.pos[1]) - hyp(x - e.pos[0], y - e.pos[1])) * 0.3
        if (s < bs) { bs = s; best = [px, py] }
      }
    }
    return best
  }

  function act(obs: any): any {
    const t0 = Date.now()
    tAct = t0
    const me = obs.self
    const t = obs.t
    const dtObs = t - lastT
    lastT = t
    const [x, y, z] = me.pos
    const out: any = { tick: obs.tick }
    const zn = obs.zone

    // ---- upgrades
    if (obs.offer && obs.offer.choices) {
      let best = 0, bestR = 1e9
      obs.offer.choices.forEach((c: any, i: number) => {
        const r = UPGRADE_PRIORITY.indexOf(c.id)
        const rr = r < 0 ? 100 : r
        if (rr < bestR) { bestR = rr; best = i }
      })
      out.pick = best
    }

    // ---- memory
    for (const m of obs.mechs || []) {
      enemies.set(m.id, { id: m.id, pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp ?? 1400, maxHp: m.max_hp ?? 1400, weapons: m.weapons || [], charging: !!m.charging, seen: t, vis: true, npc: m.kind === "npc" })
    }
    for (const [id, e] of enemies) {
      if (e.seen < t) e.vis = false
      if (t - e.seen > 12) enemies.delete(id)
    }
    for (const ev of obs.events || []) {
      if (ev.type === "damaged" && ev.weapon !== "zone") {
        lastDamageT = t
        if (ev.by != null && ev.by >= 100) npcAggro.set(ev.by, t)
        if (ev.by != null && ev.by < 100) { lastHitT = t; lastHitBy = ev.by; dmgBy.set(ev.by, (dmgBy.get(ev.by) || 0) * Math.exp(-(t - (dmgByT.get(ev.by) || t)) / 3) + ev.amount); dmgByT.set(ev.by, t) }
        if (ev.bearing != null) { threatBearing = ev.bearing; threatT = t }
      }
      if (ev.type === "kill") enemies.delete(ev.target)
    }
    for (const s of obs.sounds || []) {
      if ((s.kind === "gun" || s.kind === "laser" || s.kind === "laser_charge" || s.kind === "lightning" || s.kind === "mortar" || s.kind === "boost" || s.kind === "step") && s.dist !== "far" && t - threatT > 1.0) {
        threatBearing = s.bearing; threatT = t
      }
    }
    const all = [...enemies.values()]
    const mechsK = all.filter((e) => !e.npc && t - e.seen < 5)
    const visMechs = mechsK.filter((e) => e.vis)
    const npcs = all.filter((e) => e.npc && e.vis)
    const hpFrac = me.hp / me.max_hp

    // threats: known mechs within 260 m with a shot line to us
    const threats = mechsK.filter((e) => hyp(e.pos[0] - x, e.pos[1] - y) < 260)
    const shooting = threats.filter((e) => losShot(e.pos, e.pos[2] + 7, me.pos, z + 4.5) || losShot(e.pos, e.pos[2] + 7, me.pos, z + 8.5) || losShot(e.pos, e.pos[2] + 7, me.pos, z + 1.5))

    // ---- weapons inventory
    const wslots = me.weapons || []
    const has = (k: string) => wslots.some((w: any) => w && w.kind === k)
    const laser = wslots.find((w: any) => w && w.kind === "laser")
    const gun = wslots.find((w: any) => w && w.kind === "gun")
    const gunRange = gun?.stats?.range ?? 230

    // ---- target choice: visible mech with shot line, prefer low HP and close
    let target: Enemy | null = null, tScore = 1e9
    for (const e of visMechs) {
      const d = hyp(e.pos[0] - x, e.pos[1] - y)
      if (d > 280) continue
      if (!losShot(me.pos, z + 7, e.pos, e.pos[2] + 4.5)) continue
      const sc = d * 0.6 + e.hp * 0.08 - Math.min(150, recentDmg(e.id, t) * 0.6) - (e.charging ? 40 : 0)
      if (sc < tScore) { tScore = sc; target = e }
    }

    // ---- mode selection
    const outnumbered = shooting.length >= 2
    const retreatAt = P.retreatHp + (outnumbered ? 0.25 : 0) + (target && target.hp > me.hp * 1.3 ? 0.1 : 0)
    const lz = liveZone(zn, t)
    const dLive = hyp(x - lz.c[0], y - lz.c[1])
    const slack = zoneSlack(x, y, zn, t)
    let mx = 0, my = 0
    let wantBoost = false
    const inDanger = t - lastDamageT < 2

    if (!me.in_zone || slack < -5 || (zn.next_radius <= 0 && t > zn.shrink_start - 10)) {
      mode = "zone"
    } else if (mode === "cover") {
      const healed = hpFrac >= P.reengageHp || (t - coverT > 25 && hpFrac > 0.6)
      if (healed && !outnumbered) mode = "hold"
    } else if ((hpFrac < retreatAt && (shooting.length || inDanger)) || (outnumbered && hpFrac < 0.85)) {
      mode = "cover"; coverT = t; coverPt = null
    } else if (target && (hpFrac >= P.engageHp || target.hp < me.hp * 0.35 || recentDmg(target.id, t) > 0 || target.charging || (mode === "fight" && hpFrac >= P.retreatHp))) {
      mode = "fight"
    } else if (target || hpFrac < P.engageHp) {
      mode = shooting.length ? "cover" : "heal"
    } else {
      mode = "hold"
    }

    // ---- movement per mode
    if (mode === "zone") {
      const d = zoneDir(zn, me, t)
      const tx = zn.next_radius > 0 ? zn.next_center : zn.center
      const v = d || goTo(tx[0], tx[1], me, t)
      mx = v[0]; my = v[1]
      wantBoost = !me.in_zone || slack < -20
    } else if (mode === "cover" || (mode === "heal" && threats.length)) {
      if ((!coverPt || t - coverT > 1.5 || (coverPt && hyp(coverPt[0] - x, coverPt[1] - y) < 2 && shooting.length)) && Date.now() - tAct < 20) {
        const thr = threats.length ? threats : (threatBearing != null ? [{ pos: [x + Math.cos(threatBearing) * 80, y + Math.sin(threatBearing) * 80, z] as V3 } as Enemy] : [])
        coverPt = findCover(me, thr, zn, t)
        coverT = t - (coverPt ? 0 : 1)
        if (coverPt) coverT = t
      }
      let cubeNear: any = null
      if (shooting.length === 0) for (const c of obs.cubes || []) {
        const d = hyp(c.pos[0] - x, c.pos[1] - y)
        if (d < 25 && Math.abs(c.pos[2] - z) < 4 && (!cubeNear || d < cubeNear.d)) cubeNear = { d, c }
      }
      if (cubeNear) {
        const v = goTo(cubeNear.c.pos[0], cubeNear.c.pos[1], me, t)
        mx = v[0]; my = v[1]
      } else if (coverPt) {
        const v = goTo(coverPt[0], coverPt[1], me, t)
        mx = v[0]; my = v[1]
        wantBoost = shooting.length > 0
      } else if (threats.length) {
        // run directly away from the nearest threat
        const e = threats[0]
        const dx = x - e.pos[0], dy = y - e.pos[1], d = hyp(dx, dy) || 1
        mx = dx / d; my = dy / d; wantBoost = true
      }
    } else if (mode === "fight" && target) {
      const d = hyp(target.pos[0] - x, target.pos[1] - y)
      const theirLaser = target.weapons.includes("laser")
      const theirLight = target.weapons.includes("lightning")
      const want = laser && laser.cooldown < 1.2 ? 90 : theirLight && !has("lightning") ? 60 : P.gunRange
      const ux = (target.pos[0] - x) / (d || 1), uy = (target.pos[1] - y) / (d || 1)
      if (d > want + 30) { mx += ux * 0.7; my += uy * 0.7 }
      else if (d < want - 30 || (theirLight && d < 50)) { mx -= ux; my -= uy }
      void theirLaser
    } else {
      // hold / farm / loot
      let goal: [number, number] | null = null
      // weapon pickups
      const empty = wslots.findIndex((w: any) => !w)
      const worst = wslots[1] ? (WEAPON_RANK[wslots[1].kind] ?? 0) : -1
      let bestP: any = null, bestPs = 1e9
      for (const p of obs.pickups || []) {
        if (has(p.kind)) continue
        const r = WEAPON_RANK[p.kind] ?? 0
        if (empty < 0 && r <= worst) continue
        const d = hyp(p.pos[0] - x, p.pos[1] - y)
        if (d > 140 || zoneSlack(p.pos[0], p.pos[1], zn, t) < 0) continue
        if (world && Math.abs(p.pos[2] - world.ground(p.pos[0], p.pos[1])) > 2 && Math.abs(p.pos[2] - z) > 3) continue // roof loot: skip unless on that roof
        const sc = d - r * 25
        if (sc < bestPs) { bestPs = sc; bestP = p }
      }
      if (bestP) {
        const d = hyp(bestP.pos[0] - x, bestP.pos[1] - y)
        if (d < pickupR - 0.4 && Math.abs(bestP.pos[2] - z) < 4) { out.take = bestP.id; if (empty < 0) out.drop = 1 }
        else goal = [bestP.pos[0], bestP.pos[1]]
      }
      // cubes
      if (!goal) {
        let bc: any = null, bd = 130
        for (const c of obs.cubes || []) {
          const d = hyp(c.pos[0] - x, c.pos[1] - y)
          if (d < bd && Math.abs(c.pos[2] - z) < 4 && zoneSlack(c.pos[0], c.pos[1], zn, t) > 0) { bd = d; bc = c }
        }
        if (bc) goal = [bc.pos[0], bc.pos[1]]
      }
      if (goal) {
        const v = goTo(goal[0], goal[1], me, t)
        mx = v[0]; my = v[1]
        mode = "loot"
      } else {
        // hold a point inside the next circle; drift to a new one every ~30 s
        const nr = Math.max(0, zn.next_radius)
        if (!holdPt || t > holdT || zoneSlack(holdPt[0], holdPt[1], zn, t) < nr * P.zoneMargin * 0.5) {
          let bp: [number, number] | null = null, bs = -1e9
          for (let k = 0; k < 12; k++) {
            const a = rand() * TAU, r = Math.sqrt(rand()) * nr * (1 - P.zoneMargin)
            const px = zn.next_center[0] + Math.cos(a) * r, py = zn.next_center[1] + Math.sin(a) * r
            if (!walkable(px, py)) continue
            const s = -hyp(px - x, py - y) * 0.5 + zoneSlack(px, py, zn, t)
            if (s > bs) { bs = s; bp = [px, py] }
          }
          holdPt = bp || [zn.next_center[0], zn.next_center[1]]
          holdT = t + 25 + rand() * 15
        }
        if (hyp(holdPt[0] - x, holdPt[1] - y) > 6) { const v = goTo(holdPt[0], holdPt[1], me, t); mx = v[0] * 0.8; my = v[1] * 0.8 }
        mode = "hold"
      }
    }

    // ---- avoid drones' aggro radius unless we are fighting them
    for (const n of npcs) {
      const dx = x - n.pos[0], dy = y - n.pos[1], d = hyp(dx, dy) || 1
      if (d < 55) { mx += (dx / d) * (55 - d) / 25; my += (dy / d) * (55 - d) / 25 }
    }

    // ---- dodge: lateral jinks while anything can shoot us
    const pressed = shooting.length > 0 || t - lastHitT < 2
    if (P.jink && pressed && mode !== "zone") {
      if (t > jinkUntil) { jinkSide = rand() < 0.5 ? -1 : 1; jinkUntil = t + 0.3 + rand() * 0.55 }
      const src = shooting[0] || target
      const tb = src ? Math.atan2(src.pos[1] - y, src.pos[0] - x) : (threatBearing ?? 0)
      const w = mode === "cover" ? 0.5 : 1.1
      mx += -Math.sin(tb) * jinkSide * w; my += Math.cos(tb) * jinkSide * w
      if (me.energy > P.jinkBoostE) wantBoost = true
    }

    // ---- loot override: better weapons and cubes nearby, in any mode except zone
    if (mode !== "zone") {
      const emptyS = wslots.findIndex((w: any) => !w)
      const worstR = wslots[1] ? (WEAPON_RANK[wslots[1].kind] ?? 0) : -1
      let lg: any = null, ls = 1e9
      for (const p of obs.pickups || []) {
        if (has(p.kind)) continue
        const r = WEAPON_RANK[p.kind] ?? 0
        if (emptyS < 0 && r <= worstR) continue
        const d = hyp(p.pos[0] - x, p.pos[1] - y)
        if (Math.abs(p.pos[2] - z) > 4) continue
        if (d < pickupR - 0.4) { out.take = p.id; if (emptyS < 0) out.drop = 1 }
        const sc = d - r * 10
        if (d < P.lootFightR && sc < ls) { ls = sc; lg = p }
      }
      for (const c of obs.cubes || []) {
        const d = hyp(c.pos[0] - x, c.pos[1] - y)
        if (d < P.lootFightR && Math.abs(c.pos[2] - z) < 4 && d + 5 < ls) { ls = d + 5; lg = c }
      }
      const pressing = shooting.length >= 2 || (mode === "cover" && shooting.length >= 1)
      if (lg && !pressing && zoneSlack(lg.pos[0], lg.pos[1], zn, t) > 0) {
        const v = goTo(lg.pos[0], lg.pos[1], me, t)
        const w = mode === "fight" ? 1.5 : 3
        mx = mx * 0.3 + v[0] * w; my = my * 0.3 + v[1] * w
      }
    }

    // ---- zone guard: never step out of the safe area while doing something else
    if (mode !== "zone" && nav) {
      const nx = x + mx * 6, ny = y + my * 6
      if (zoneSlack(nx, ny, zn, t) < 0 && zoneSlack(nx, ny, zn, t) < slack) {
        const d = zoneDir(zn, me, t)
        if (d) { mx = mx * 0.3 + d[0]; my = my * 0.3 + d[1] }
      }
    }

    let ml = hyp(mx, my)
    if (ml > 1e-3) { mx /= ml; my /= ml } else { mx = 0; my = 0 }

    // ---- stuck handling
    if (lastPos && dtObs > 0) {
      const moved = hyp(x - lastPos[0], y - lastPos[1])
      if (ml > 0.1 && moved < 0.2) stuckT += dtObs
      else stuckT = Math.max(0, stuckT - dtObs * 2)
    }
    lastPos = [x, y, z]
    if (stuckT > 0.6 && t > unstickUntil) {
      unstickUntil = t + 1.0
      unstickDir = Math.atan2(my, mx) + (rand() < 0.5 ? 1.2 : -1.2)
      stuckT = 0
      goalT = -99
    }
    let jump = false
    if (t < unstickUntil) {
      mx = Math.cos(unstickDir); my = Math.sin(unstickDir)
      if (me.grounded) jump = true
      wantBoost = me.energy > 15
    }
    out.move = [mx, my]
    out.boost = wantBoost && me.energy > 8 && (me.grounded || t < unstickUntil)

    // ---- aim and fire
    const fire: [boolean, boolean] = [false, false]
    const aim = me.aim
    let aimT: { pos: V3; vel: V3; h: number; d: number; kind: string } | null = null
    if (target) aimT = { pos: target.pos, vel: target.vel, h: 4.5, d: hyp(target.pos[0] - x, target.pos[1] - y), kind: "mech" }
    // farming when nothing threatens us
    if (target && mode !== "fight" && recentDmg(target.id, t) <= 0 && !target.charging) aimT = null
    if (!aimT && shooting.length === 0 && mode !== "zone" && (hpFrac >= P.farmHp || [...npcAggro.values()].some((v) => t - v < 8))) {
      let best: any = null, bd = 1e9
      for (const n of npcs) {
        if (t - (npcAggro.get(n.id) ?? -99) > 8) continue
        const d = hyp(n.pos[0] - x, n.pos[1] - y)
        if (d < bd && losShot(me.pos, z + 7, n.pos, n.pos[2] + 1.75)) { bd = d; best = { pos: n.pos, vel: n.vel, h: 1.75, d, kind: "npc", id: n.id } }
      }
      if (best) bd = -1
      if (t - lastHitT < 3 && !best) bd = -1
      if (P.farmNpc) for (const n of npcs) {
        const d = hyp(n.pos[0] - x, n.pos[1] - y)
        if (d < 200 && losShot(me.pos, z + 7, n.pos, n.pos[2] + 1.75) && (laser || d < 160)) { if (d < bd) { bd = d; best = { pos: n.pos, vel: n.vel, h: 1.75, d, kind: "npc", id: n.id } } }
      }
      if (!best && P.farmCrates) for (const c of obs.crates || []) {
        const d = hyp(c.pos[0] - x, c.pos[1] - y)
        if (d < 150 && losShot(me.pos, z + 7, c.pos, c.pos[2] + 1.2)) { if (d < bd) { bd = d; best = { pos: c.pos, vel: [0, 0, 0], h: 1.2, d, kind: "crate", id: c.id } } }
      }
      if (best) aimT = best
    }
    if (aimT) {
      const gs = gun?.stats?.speed ?? cfg.weapons.gun.speed
      const [ay, ap, dh] = lead(me, aimT.pos, aimT.vel, aimT.h, gs)
      out.aim = [ay, ap]
      const yawErr = Math.abs(wrap(aim[0] - ay)), pitErr = Math.abs(aim[1] - ap)
      const size = aimT.kind === "mech" ? 2.0 : aimT.kind === "npc" ? 1.4 : 1.0
      const tol = Math.max(0.006, Math.atan2(size, dh))
      // laser: aim straight at the target (hitscan)
      const mh = me.stats?.muzzle_height ?? 7
      const lYaw = Math.atan2(aimT.pos[1] + aimT.vel[1] * 0.1 - y, aimT.pos[0] + aimT.vel[0] * 0.1 - x)
      const lPit = Math.atan2(aimT.pos[2] + aimT.h - (z + mh), dh)
      const lErr = Math.abs(wrap(aim[0] - lYaw)) + Math.abs(aim[1] - lPit)
      wslots.forEach((w: any, i: number) => {
        if (!w) return
        if (w.kind === "gun") {
          fire[i] = dh < gunRange && yawErr < tol && pitErr < tol * 1.5 && w.reload === 0 && (aimT!.kind !== "npc" || dh > 50 || t - (npcAggro.get((aimT as any).id) ?? -99) < 8)
        } else if (w.kind === "laser") {
          const full = w.stats?.charge ?? 0.75
          if (dh < (w.stats?.range ?? 280)) {
            if (!(w.charge > 0)) fire[i] = w.cooldown <= 0.05
            else fire[i] = !(w.charge >= full - 0.01 && lErr < tol * 1.2)
          }
        } else if (w.kind === "lightning") {
          const range = w.stats?.range ?? 45
          const cone = ((w.stats?.cone_deg ?? 30) * Math.PI) / 180
          fire[i] = (aimT!.kind === "mech" || (aimT!.kind === "npc" && t - (npcAggro.get((aimT as any).id) ?? -99) < 8)) && dh < range - 2 && yawErr < cone * 0.7 && me.energy > 12
        }
      })
      if (laser && laser.charge > 0 && laser.charge >= (laser.stats?.charge ?? 0.75) - 0.01) out.aim = [lYaw, lPit]
    } else {
      // keep a charged laser ready? no: release safely by not holding (fires a weak shot only if charging)
      let yaw: number
      const recentThreat = threatBearing != null && t - threatT < 4
      const known = mechsK.length ? mechsK.reduce((a, b) => (hyp(a.pos[0] - x, a.pos[1] - y) < hyp(b.pos[0] - x, b.pos[1] - y) ? a : b)) : null
      if (known) yaw = Math.atan2(known.pos[1] - y, known.pos[0] - x)
      else if (recentThreat) yaw = threatBearing!
      else {
        scanPhase += 0.35
        const base = ml > 0.1 ? Math.atan2(my, mx) : aim[0]
        yaw = wrap(base + Math.sin(scanPhase) * 1.6)
      }
      out.aim = [yaw, 0]
      if (gun && gun.ammo < (gun.stats?.mag ?? 12) * 0.6 && gun.reload === 0) out.reload = true
    }
    out.fire = fire
    if (jump) out.jump = true
    out.debug = { label: mode + (target ? " t" + target.id : "") + " s" + shooting.length }
    void t0
    return out
  }

  return { name: "survivor", act }
}
