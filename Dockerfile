FROM node:20-slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh \
  | sh

ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app
COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
