FROM node:22-alpine

WORKDIR /application

COPY package*.json ./ 

RUN npm cache clean --force
RUN npm install
RUN npm install -g pm2

COPY . .

EXPOSE 4000

CMD ["pm2-runtime", "src/app.js"]
