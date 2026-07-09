# ---- build stage: install everything, build the client ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared shared
COPY server server
COPY client client
RUN npm run build -w client

# ---- runtime stage: server deps only + built client ----
FROM node:24-slim
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/messenger.db
ENV UPLOADS_DIR=/data/uploads
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server && npm cache clean --force
COPY shared shared
COPY server server
COPY --from=build /app/client/dist client/dist
VOLUME /data
EXPOSE 3001
CMD ["npm", "run", "start", "-w", "server"]
