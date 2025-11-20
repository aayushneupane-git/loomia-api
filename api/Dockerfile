FROM node:20

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Create app directory
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "server.js"]
