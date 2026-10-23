FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app
COPY worker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY worker/src ./src
COPY web/resume-pdf.js /web/resume-pdf.js
ENV NODE_ENV=production
CMD ["npm", "start"]
