FROM node:24-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
