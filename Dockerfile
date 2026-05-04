FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
ENV STORAGE_ROOT=/data/images
ENV PUBLIC_PATH_PREFIX=cdn

EXPOSE 8080

CMD ["npm", "start"]
