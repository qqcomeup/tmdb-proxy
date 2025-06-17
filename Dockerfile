FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY . .

RUN npm install -g vercel

EXPOSE 6000

CMD ["vercel", "dev", "--listen", "0.0.0.0:6000", "--debug"]
