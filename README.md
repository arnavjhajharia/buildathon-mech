# buildathon-mech

A bot for the mechfight/1 battle royale (16 mechs, JSON lines on stdin/stdout).

- `src/main.ts`: protocol loop (answers the newest observation, coasts on errors, warms the JIT during `hello`).
- `src/bot.ts`: decision logic (zone, threat distance, dodging, facing the attacker, leading shots, loot, upgrades).
- `Dockerfile`: `node:22.21.1-slim` pinned by digest; runs the TypeScript sources directly with Node's type stripping.

Libraries: none beyond the Node.js runtime (MIT). No npm dependencies.

License: MIT (see LICENSE).
