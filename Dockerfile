FROM node:20-alpine

# Install build dependencies for native node-gyp packages like sqlite3
RUN apk add --no-cache python3 make g++ gcc

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
