FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development \
    LOCAL_DATA_PATH=/data

RUN mkdir -p /app /data /backups && chown -R node:node /app /data /backups

COPY --chown=node:node package.json package-lock.json .npmrc ./

USER node
RUN npm ci --no-audit --no-fund

COPY --chown=node:node . .

EXPOSE 4173
VOLUME ["/data", "/backups"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
