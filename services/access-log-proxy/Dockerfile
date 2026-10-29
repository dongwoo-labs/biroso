FROM node:22-alpine
WORKDIR /app
COPY access-log-proxy.mjs ./
RUN mkdir -p /var/log/twenty-access && chown node /var/log/twenty-access
USER node
EXPOSE 3100
CMD ["node", "access-log-proxy.mjs"]
