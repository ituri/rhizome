FROM node:22-alpine
WORKDIR /app
COPY server.js db.js accounts.js opsdoc.js cryptobox.js package.json ./
COPY public ./public
ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
