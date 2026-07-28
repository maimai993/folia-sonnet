FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY deploy/docker/netease-api/package.json deploy/docker/netease-api/package-lock.json ./
RUN npm ci --omit=dev

USER node
EXPOSE 3000

CMD ["node", "node_modules/@neteasecloudmusicapienhanced/api/app.js"]
