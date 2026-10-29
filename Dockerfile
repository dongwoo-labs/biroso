# API 서버, 사이트 재빌드, 예약 작업이 같이 쓰는 이미지. 빌드에 쓰는 Astro가 dependencies에 있어 --omit=dev로 충분하다.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN chown -R node /app
USER node
ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "server/server.mjs"]
