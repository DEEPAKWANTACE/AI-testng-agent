# One image for every service; Railway sets a different start command per service:
#   web          npm run start            (pre-deploy: npm run deploy:prepare)
#   workers      npm run workers
#   demo-shop    npm run demo:target
# The Playwright base image ships Chromium and its system libraries for the workers.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]
