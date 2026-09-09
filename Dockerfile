FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3-opencv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY *.js *.py ./
RUN mkdir -p /app/jobs
ENV PORT=8080
EXPOSE 8080
CMD ["npm","start"]
