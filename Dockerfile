# WebAudit AI — one image for the API and the scan worker.
# Based on the official Playwright image so Chromium and its system libraries match playwright-core.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
# Run as the unprivileged user that ships with the Playwright image.
RUN mkdir -p /data/storage && chown -R pwuser:pwuser /data
USER pwuser
ENV STORAGE_DIR=/data/storage HOST=0.0.0.0 PORT=4100
EXPOSE 4100
CMD ["node", "server/dist/index.js"]
