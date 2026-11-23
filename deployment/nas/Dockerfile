ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY public ./public
COPY config ./config
# NAS extraction may leave root-owned files at 0600 and directories at 0700.
# Normalize application access before switching to the runtime user.
RUN chmod 755 /app \
    && chmod 644 /app/package.json /app/package-lock.json \
    && find /app/server /app/public /app/config -type d -exec chmod 755 {} + \
    && find /app/server /app/public /app/config -type f -exec chmod 644 {} + \
    && chmod -R a+rX /app/node_modules \
    && mkdir -p /app/data \
    && chown node:node /app/data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data
USER node
# Importing the server checks its dependencies without starting it or opening data.
RUN node --input-type=module -e "\
    import { readFile, access, constants } from 'node:fs/promises'; \
    await import('./server/index.js'); \
    await Promise.all(['package.json', 'public/index.html', 'public/app.js', 'public/styles.css', 'public/playback-utils.js', 'config/initial-sources.json', 'node_modules/hls.js/dist/hls.min.js'].map(path => readFile(path))); \
    await access('data', constants.W_OK | constants.X_OK); \
    console.log('Runtime file permission check passed');"
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
