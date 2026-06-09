FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev && npm install tsx
COPY --from=build /app/dist ./dist
COPY server ./server
COPY @/ ./@/

VOLUME /app/data
EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

CMD ["npx", "tsx", "server/index.ts"]
