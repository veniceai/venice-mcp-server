FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts --no-fund

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3333
ENV VENICE_MCP_HTTP=1
# Container needs to bind all interfaces so the host port mapping reaches it.
# HTTP startup requires VENICE_MCP_AUTH_TOKEN for this non-loopback bind unless
# VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP=1 is set behind a trusted proxy.
ENV VENICE_MCP_HOST=0.0.0.0
USER node
CMD ["node", "dist/cli.js", "--http"]
