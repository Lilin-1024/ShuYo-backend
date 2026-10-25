FROM node:24-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts/admin-cli.js ./scripts/admin-cli.js
COPY scripts/clear-legacy-presence.js ./scripts/clear-legacy-presence.js
COPY scripts/import-course-catalog.js ./scripts/import-course-catalog.js
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
