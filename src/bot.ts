// Survive-first mech bot for mechfight/1.
// Priorities: stay inside the zone, keep distance from threats, dodge by changing lateral direction,
// face whoever is shooting (rear hits deal 1.5x), and shoot back with lead.

type V3 = [number, number, number]

const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const hyp = (x: number, y: number) => Math.sqrt(x * x + y * y)

// Small deterministic RNG (mulberry32).
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

const UPGRADE_PRIORITY = [
  "armor", "plating", "nanites", "laser_damage", "laser_charge", "gun_damage", "gun_rate", "servos",
  "gyros", "gun_mag", "jets", "capacitor", "reactor", "gun_velocity", "lightning_efficiency",
  "lightning_range", "mortar_reload", "sensors", "lightning_chain", "mortar_velocity", "mortar_splash", "laser_pierce",
]
const WEAPON_RANK: Record<string, number> = { laser: 3, lightning: 2, mortar: 1, gun: 0 }

export function createBot(hello: any) {
  const cfg = hello.config
  const W = cfg.weapons
  const rand = rng(hello.seed || 1)
  const pickupR = cfg.loot?.pickup_radius ?? 4

  let jinkSide = 1
  let jinkUntil = 0
  let lastPos: V3 | null = null
  let stuckT = 0
  let unstickUntil = 0
  let unstickDir = 0
  let lastHitT = -99
  let threatBearing: number | null = null
  let threatT = -99
  let lastSeen = new Map<number, { pos: V3; t: number }>()
  let scanYaw = 0

  function leadAim(me: any, tgt: any, speed: number): [number, number, number] {
    const mh = me.stats?.muzzle_height ?? 7
    const mx = me.pos[0], my = me.pos[1], mz = me.pos[2] + mh
    const tz0 = tgt.pos[2] + (tgt.kind === "npc" ? 1.75 : 4.5)
    let t = 0
    let px = tgt.pos[0], py = tgt.pos[1], pz = tz0
    for (let k = 0; k < 4; k++) {
      px = tgt.pos[0] + tgt.vel[0] * t
      py = tgt.pos[1] + tgt.vel[1] * t
      pz = tz0 + (Math.abs(tgt.vel[2]) > 0.5 ? tgt.vel[2] * t : 0)
      const d = Math.sqrt((px - mx) ** 2 + (py - my) ** 2 + (pz - mz) ** 2)
      t = d / speed
    }
    const dh = hyp(px - mx, py - my)
    return [Math.atan2(py - my, px - mx), Math.atan2(pz - mz, dh), dh]
  }

  function mortarAim(me: any, tgt: any, w: any): [number, number] | null {
    const v = w.speed, g = w.gravity
    const mz = me.pos[2] + (me.stats?.height ?? 9) + 0.5
    let px = tgt.pos[0], py = tgt.pos[1]
    let tof = 0
    for (let k = 0; k < 3; k++) {
      px = tgt.pos[0] + tgt.vel[0] * tof
      py = tgt.pos[1] + tgt.vel[1] * tof
      const d = hyp(px - me.pos[0], py - me.pos[1])
      const h = tgt.pos[2] - mz
      const disc = v ** 4 - g * (g * d * d + 2 * h * v * v)
      if (disc < 0) return null
      const th = Math.atan((v * v - Math.sqrt(disc)) / (g * d))
      tof = d / (v * Math.cos(th))
      if (k === 2) return [Math.atan2(py - me.pos[1], px - me.pos[0]), th]
    }
    return null
  }

  function act(obs: any): any {
    const me = obs.self
    const t = obs.t
    const [x, y, z] = me.pos
    const out: any = { tick: obs.tick }

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

    // ---- threats
    for (const ev of obs.events || []) {
      if (ev.type === "damaged" && ev.weapon !== "zone") {
        lastHitT = t
        if (ev.bearing != null) { threatBearing = ev.bearing; threatT = t }
      }
    }
    const enemies = (obs.mechs || []).filter((m: any) => m.kind === "mech")
    const npcs = (obs.mechs || []).filter((m: any) => m.kind === "npc")
    for (const m of enemies) lastSeen.set(m.id, { pos: m.pos, t })
    for (const s of obs.sounds || []) {
      if ((s.kind === "gun" || s.kind === "laser" || s.kind === "laser_charge" || s.kind === "lightning" || s.kind === "mortar") &&
          s.dist !== "far" && t - threatT > 1.5) {
        threatBearing = s.bearing; threatT = t
      }
    }

    // target: prefer close & weak
    let target: any = null, tScore = 1e9
    for (const m of enemies) {
      const d = hyp(m.pos[0] - x, m.pos[1] - y)
      const sc = d + (m.hp ?? 1400) * 0.05
      if (sc < tScore) { tScore = sc; target = m }
    }

    // ---- zone goal
    const zn = obs.zone
    const beforeShrink = t < zn.shrink_start
    const curR = zn.radius, nc = zn.next_center, nr = zn.next_radius
    const dNext = hyp(x - nc[0], y - nc[1])
    const dCur = hyp(x - zn.center[0], y - zn.center[1])
    let gx = 0, gy = 0
    // desired: be inside the next circle with margin
    const margin = Math.max(8, nr * 0.25)
    const timeToShrinkEnd = zn.shrink_end - t
    if (dNext > nr - margin && nr > 0) {
      const ux = (nc[0] - x) / (dNext || 1), uy = (nc[1] - y) / (dNext || 1)
      const urgency = !me.in_zone ? 3 : (dNext - (nr - margin)) / Math.max(20, timeToShrinkEnd * me.stats.walk_speed * 0.5)
      gx += ux * Math.min(3, 0.6 + urgency)
      gy += uy * Math.min(3, 0.6 + urgency)
    } else if (nr <= 0) {
      const ux = (nc[0] - x) / (dNext || 1), uy = (nc[1] - y) / (dNext || 1)
      gx += ux * 2; gy += uy * 2
    }
    if (!me.in_zone) {
      const ux = (zn.center[0] - x) / (dCur || 1), uy = (zn.center[1] - y) / (dCur || 1)
      gx += ux * 3; gy += uy * 3
    }

    // ---- threat repulsion (keep distance, more when hurt)
    const hpFrac = me.hp / me.max_hp
    let fx = 0, fy = 0
    for (const m of enemies) {
      const dx = x - m.pos[0], dy = y - m.pos[1]
      const d = hyp(dx, dy) || 1
      const want = 90 + (1 - hpFrac) * 80
      if (d < want) {
        const w = (want - d) / want * 1.5
        fx += dx / d * w; fy += dy / d * w
      }
    }
    for (const n of npcs) {
      const dx = x - n.pos[0], dy = y - n.pos[1]
      const d = hyp(dx, dy) || 1
      if (d < 60) { fx += dx / d * (60 - d) / 60; fy += dy / d * (60 - d) / 60 }
    }

    // ---- loot: weapons and cubes nearby
    let lx = 0, ly = 0
    const wslots = me.weapons || []
    const held = new Set(wslots.filter((w: any) => w).map((w: any) => w.kind))
    const empty = wslots.findIndex((w: any) => !w)
    const worst1 = wslots[1] ? (WEAPON_RANK[wslots[1].kind] ?? 0) : -1
    let bestP: any = null, bestPd = 1e9
    for (const p of obs.pickups || []) {
      if (held.has(p.kind)) continue
      const r = WEAPON_RANK[p.kind] ?? 0
      if (empty < 0 && r <= worst1) continue
      const d = hyp(p.pos[0] - x, p.pos[1] - y)
      if (Math.abs(p.pos[2] - z) > 6 && d < 6) continue
      const sc = d - r * 15
      if (sc < bestPd && d < 120) { bestPd = sc; bestP = p }
    }
    if (bestP) {
      const d = hyp(bestP.pos[0] - x, bestP.pos[1] - y)
      if (d < pickupR - 0.3 && Math.abs(bestP.pos[2] - z) < 4) {
        out.take = bestP.id
        if (empty < 0) out.drop = 1
      } else {
        lx += (bestP.pos[0] - x) / d * 1.2; ly += (bestP.pos[1] - y) / d * 1.2
      }
    }
    let bestC: any = null, bestCd = 60
    for (const c of obs.cubes || []) {
      const d = hyp(c.pos[0] - x, c.pos[1] - y)
      if (d < bestCd) { bestCd = d; bestC = c }
    }
    if (bestC && !bestP) {
      lx += (bestC.pos[0] - x) / (bestCd || 1); ly += (bestC.pos[1] - y) / (bestCd || 1)
    }

    // ---- combine movement
    let mx = gx + fx + lx, my = gy + fy + ly
    const underFire = t - lastHitT < 3
    const threatened = target || underFire
    if (threatened) {
      if (t > jinkUntil) {
        jinkSide = rand() < 0.5 ? -1 : 1
        jinkUntil = t + 0.35 + rand() * 0.6
      }
      let tb = target ? Math.atan2(target.pos[1] - y, target.pos[0] - x) : (threatBearing ?? 0)
      const px = -Math.sin(tb) * jinkSide, py = Math.cos(tb) * jinkSide
      mx += px * 1.2; my += py * 1.2
    }
    let mlen = hyp(mx, my)
    if (mlen < 0.15) { mx = 0; my = 0 } else { mx /= mlen; my /= mlen }

    // stuck detection
    if (lastPos) {
      const moved = hyp(x - lastPos[0], y - lastPos[1])
      if (mlen > 0.15 && moved < 0.25) stuckT += 0.1
      else stuckT = Math.max(0, stuckT - 0.2)
    }
    lastPos = [x, y, z]
    if (stuckT > 0.6 && t > unstickUntil) {
      unstickUntil = t + 1.2
      unstickDir = Math.atan2(my, mx) + (rand() < 0.5 ? 1 : -1) * (Math.PI / 2)
      stuckT = 0
    }
    let jump = false, boost = false
    if (t < unstickUntil) {
      mx = Math.cos(unstickDir); my = Math.sin(unstickDir)
      if (me.grounded) jump = true
      boost = me.energy > 20
    }
    if (!me.in_zone && me.energy > 10) boost = true
    if (threatened && me.energy > 50 && me.grounded) boost = true

    out.move = [mx, my]

    // ---- aim and fire
    const fire: [boolean, boolean] = [false, false]
    const aim = me.aim
    if (target) {
      const gunW = wslots.find((w: any) => w && w.kind === "gun")
      const gs = gunW?.stats?.speed ?? W.gun.speed
      const [ay, ap, dh] = leadAim(me, target, gs)
      out.aim = [ay, ap]
      const yawErr = Math.abs(wrap(aim[0] - ay))
      const pitErr = Math.abs(aim[1] - ap)
      const tol = Math.max(0.008, Math.atan2(2.0, dh))
      wslots.forEach((w: any, i: number) => {
        if (!w) return
        if (w.kind === "gun") {
          fire[i] = dh < (w.stats?.range ?? 230) && yawErr < tol && pitErr < tol * 1.5 && w.reload === 0
        } else if (w.kind === "laser") {
          const full = w.stats?.charge ?? 0.75
          const range = w.stats?.range ?? 280
          if (dh < range) {
            const charging = (w.charge ?? 0) > 0
            if (!charging) fire[i] = w.cooldown <= 0.05
            else fire[i] = !(w.charge >= full - 0.02 && yawErr < tol && pitErr < tol * 1.5)
          }
        } else if (w.kind === "lightning") {
          const range = w.stats?.range ?? 45
          const cone = ((w.stats?.cone_deg ?? 30) * Math.PI) / 180 / 2
          fire[i] = dh < range - 1 && yawErr < cone * 0.8 && me.energy > 8
        } else if (w.kind === "mortar") {
          const ma = mortarAim(me, target, w.stats || W.mortar)
          if (ma && dh > 35 && w.cooldown <= 0) {
            // mortar shares the torso aim; only fire if aim happens to suit it
            const e1 = Math.abs(wrap(aim[0] - ma[0])), e2 = Math.abs(aim[1] - ma[1])
            if (e1 < 0.03 && e2 < 0.03) fire[i] = true
          }
        }
      })
      // mortar-only aim preference when the gun is out of range
      const mort = wslots.findIndex((w: any) => w && w.kind === "mortar")
      if (mort >= 0 && dh > 120 && wslots[mort].cooldown <= 0.3) {
        const ma = mortarAim(me, target, wslots[mort].stats || W.mortar)
        if (ma) out.aim = ma
      }
    } else {
      // no visible target: look toward the latest threat, else scan around while moving
      let yaw: number
      if (threatBearing != null && t - threatT < 4) yaw = threatBearing
      else {
        scanYaw = wrap(scanYaw + 0.25)
        const base = mlen > 0.15 ? Math.atan2(my, mx) : aim[0]
        yaw = wrap(base + Math.sin(t * 0.8) * 1.0)
      }
      out.aim = [yaw, 0]
      const gunW = wslots[0]
      if (gunW && gunW.kind === "gun" && gunW.ammo < (gunW.stats?.mag ?? 12) / 2 && gunW.reload === 0) out.reload = true
    }
    out.fire = fire
    out.boost = boost
    if (jump) out.jump = true
    return out
  }

  return { name: "survivor", act }
}
