# API 서버, 사이트 재빌드, 예약 작업이 같이 쓰는 이미지. 빌드에 쓰는 Astro가 dependencies에 있어 --omit=dev로 충분하다.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
# 진료기록 봉인 장부 볼륨(/data/charts)을 node 사용자가 쓰도록 이미지에 미리 만든다(빈 볼륨은 이 소유자를 물려받는다)
RUN mkdir -p /data/charts && chown -R node /app /data/charts
USER node
ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "server/server.mjs"]
