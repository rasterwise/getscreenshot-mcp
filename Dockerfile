# syntax=docker/dockerfile:1

# ---- build: compile TypeScript ------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies + compiled output -----------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY LICENSE README.md ./

# The official image ships an unprivileged "node" user (uid 1000).
USER node
ENV PORT=8080
# Fewer glibc malloc arenas: less fragmentation from libvips' worker threads (sharp's own advice).
ENV MALLOC_ARENA_MAX=2
EXPOSE 8080
# --expose-gc lets the server ask for a collection after each image job, so dead
# pixel buffers do not pile up between V8's own major collections.
CMD ["node", "--expose-gc", "dist/bin.js", "--http"]
