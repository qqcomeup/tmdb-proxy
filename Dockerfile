FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN npm install -g vercel

EXPOSE 3000

CMD ["vercel", "dev", "--listen", "0.0.0.0:3000", "--debug"]
