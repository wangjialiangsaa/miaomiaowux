FROM node:24-alpine
RUN apk add --no-cache docker-cli docker-cli-compose util-linux
WORKDIR /app
COPY updater/*.mjs updater/release-signing.pub ./updater/
USER 0:10001
ENTRYPOINT ["flock", "--nonblock", "/state/updater.lock", "node", "updater/main.mjs"]
