FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
