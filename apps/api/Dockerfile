# Build the docker image with `pnpm nx run @xapply/api:docker:build`.
# The base image is pinned to Node 24, the version CI tests with.
FROM docker.io/node:24-alpine

ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY dist .

RUN npm --omit=dev -f install

CMD [ "node", "main.js" ]
