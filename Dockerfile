# Node 22 runs the TypeScript sources directly (type stripping, no build step, no dependencies).
FROM node:22.21.1-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c
WORKDIR /bot
COPY src/ /bot/src/
ENV NODE_NO_WARNINGS=1
ENTRYPOINT ["node", "/bot/src/main.ts"]
