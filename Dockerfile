FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY grafana-ruler-proxy.js .
EXPOSE 8080
CMD ["node", "grafana-ruler-proxy.js"]