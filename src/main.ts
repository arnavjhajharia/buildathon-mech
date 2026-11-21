// mechfight/1 stdin/stdout loop. Answers only the newest observation when several are queued.
import { createBot } from "./bot.ts"

type Bot = { name?: string; act(obs: any): any }

let bot: Bot | null = null
let buf = ""
let pending: any = null
let lastGood: any = null

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function handle(msg: any) {
  if (msg.type === "hello") {
    try {
      warmup(msg)
    } catch (e) {
      console.error("warmup failed", e)
    }
    try {
      bot = createBot(msg)
    } catch (e) {
      console.error("createBot failed", e)
      bot = null
    }
    send({ type: "ready", name: (bot && bot.name) || "survivor" })
  } else if (msg.type === "obs") {
    pending = msg
  } else if (msg.type === "end") {
    flush()
    process.exit(0)
  }
}

// Run a throwaway bot on synthetic observations so the JIT has compiled the hot paths
// before the first real decision (the hello budget is 20 s; this takes well under 1 s).
function warmup(hello: any) {
  const t0 = Date.now()
  const b = createBot(hello)
  const z = hello.config?.zone?.start_center ?? [0, 0]
  for (let i = 0; i < 400 && Date.now() - t0 < 1500; i++) {
    const tt = i * 0.1
    const obs = {
      type: "obs", tick: i * 2, t: tt, alive: 16,
      self: { id: 0, pos: [z[0] + i * 0.3, z[1], 0], vel: [3, 0, 0], aim: [0.1 * (i % 7), 0], hp: 1400 - i, max_hp: 1400,
        energy: 100 - (i % 50), max_energy: 100, grounded: i % 9 !== 0, cubes: 0, upgrades: [], in_zone: i % 13 !== 0,
        weapons: [{ kind: "gun", cooldown: 0, ammo: 12 - (i % 12), reload: 0, stats: { damage: 45, cooldown: 0.24, speed: 252, range: 230, spread_deg: 0.6, mag: 12, reload: 2.4 } },
          i % 3 === 0 ? { kind: "laser", cooldown: 0, charge: (i % 10) * 0.1, stats: { damage: 315, charge: 0.75, range: 280, cooldown: 1.65 } } :
          i % 3 === 1 ? { kind: "lightning", cooldown: 0, stats: { damage: 60, range: 45, cone_deg: 30, cooldown: 0.25 } } :
          { kind: "mortar", cooldown: 0, stats: { speed: 72, gravity: 22, cooldown: 2.6 } }],
        stats: { walk_speed: 11.7, boost_speed: 19.5, turn_rate: 4, muzzle_height: 7, height: 9 } },
      mechs: [
        { id: 5, kind: "mech", pos: [z[0] + 60 + (i % 40), z[1] + 20, 1], vel: [2, -3, 0], aim: [3, 0], hp: 900, max_hp: 1400, cubes: 1, weapons: ["gun", "laser"], charging: i % 5 === 0 },
        { id: 104, kind: "npc", pos: [z[0] - 40, z[1] - 30, 0], vel: [1, 0, 0], aim: [0, 0], hp: 350, max_hp: 350 },
      ],
      projectiles: [{ id: 1, kind: "gun", pos: [z[0] + 30, z[1] + 10, 7], vel: [-200, -50, 0] }],
      crates: [{ id: 1001, pos: [z[0] + 10, z[1] + 10, 0], hp: 300 }],
      cubes: [{ id: 5001, pos: [z[0] + 5, z[1] - 5, 0] }],
      pickups: [{ id: 8001, kind: "laser", pos: [z[0] + 2, z[1] + 1, 0] }],
      sounds: [{ kind: "gun", bearing: 1.0, dist: "mid", age: 0.05 }],
      beams: [],
      events: i % 4 === 0 ? [{ type: "damaged", amount: 45, weapon: "gun", bearing: 0.5, by: 5 }] : [],
      drops: [],
      zone: { center: z, radius: 560, next_center: z, next_radius: 380, shrink_start: 60, shrink_end: 110, dps: 20 },
      offer: i % 50 === 0 ? { id: 1, expires: tt + 5, choices: [{ id: "armor" }, { id: "plating" }, { id: "servos" }] } : null,
    }
    JSON.stringify(b.act(obs))
  }
}

function flush() {
  if (!pending) return
  const obs = pending
  pending = null
  let act: any = null
  try {
    if (bot) act = bot.act(obs)
  } catch (e) {
    console.error("act failed", e)
  }
  if (!act) {
    act = lastGood ? { move: lastGood.move, aim: lastGood.aim, boost: lastGood.boost } : {}
  } else {
    lastGood = act
  }
  act.tick = obs.tick
  send(act)
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  let i: number
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg)
  }
  flush()
})
process.stdin.on("end", () => process.exit(0))
