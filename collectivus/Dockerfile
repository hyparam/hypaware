FROM node:24-alpine

WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/hyparam/collectivus"
LABEL org.opencontainers.image.description="Collectivus OTLP collector, central server, gateway, and rendezvous service"
LABEL org.opencontainers.image.licenses="MIT"

COPY package.json ./
RUN npm install --omit=dev

COPY bin ./bin
COPY src ./src

USER node

VOLUME ["/data"]

EXPOSE 8788 8789

ENTRYPOINT ["node", "bin/cli.js"]
