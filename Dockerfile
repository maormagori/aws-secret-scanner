# The lockfile was written by npm 11.6.2; newer npm rejects it (missing optional wasm deps), so both stages use it.
ARG NPM_VERSION=11.6.2

FROM node:24-alpine AS build
ARG NPM_VERSION
RUN npm install -g npm@${NPM_VERSION}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:24-alpine
ARG NPM_VERSION
RUN apk add --no-cache git && npm install -g npm@${NPM_VERSION}
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/src/apiMain.js"]
