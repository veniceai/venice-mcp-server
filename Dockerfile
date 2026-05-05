FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3333
ENV VENICE_MCP_HTTP=1
# Container needs to bind all interfaces so the host port mapping reaches it.
ENV VENICE_MCP_HOST=0.0.0.0
CMD ["node", "dist/cli.js", "--http"]
