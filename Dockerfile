FROM node:22-alpine
WORKDIR /app
COPY server.js db.js accounts.js opsdoc.js cryptobox.js package.json ./
COPY public ./public
# the running commit, stamped in at build time so the app can report its own version and detect
# when a newer one is available (compose passes GIT_COMMIT; see deploy.sh)
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
