FROM ghcr.io/puppeteer/puppeteer:21.5.2

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

# GD-131 : npm install doit tourner en root car COPY cree les fichiers
# avec uid=0 meme quand USER pptruser est actif dans l'image de base.
# pptruser est restaure avant CMD pour le sandboxing Chromium/Puppeteer.
USER root
COPY package*.json ./
RUN npm install --omit=dev

COPY . .
USER pptruser

CMD ["node", "radar-bc-bot.js"]
