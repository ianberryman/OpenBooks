FROM node:14

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 4000
CMD ["npm", "start"]