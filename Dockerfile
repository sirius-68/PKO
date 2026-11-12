# The server has no runtime dependencies — Node 22 is all it needs.
FROM node:22-slim
WORKDIR /srv
COPY server ./server
COPY app ./app
COPY admin ./admin
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "--no-warnings", "server/src/index.ts"]
