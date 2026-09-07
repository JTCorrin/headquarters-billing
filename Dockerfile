FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN corepack enable && \
  if [ -f pnpm-lock.yaml ]; then corepack prepare pnpm@10.34.5 --activate && pnpm install --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  else npm install; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN corepack enable && \
  if [ -f pnpm-lock.yaml ]; then corepack prepare pnpm@10.34.5 --activate && pnpm install --prod --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci --omit=dev; \
  else npm install --omit=dev; fi
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.js"]
