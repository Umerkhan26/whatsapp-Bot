FROM node:18-slim

# Install required packages and Chromium
RUN apt-get update && apt-get install -y \
  wget \
  gnupg \
  ca-certificates \
  chromium \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libgdk-pixbuf2.0-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Install nodemon globally for hot reload
RUN npm install -g nodemon

# Set working directory
WORKDIR /app

# Copy only package.json first for layer caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the source code
COPY . .

# Expose port
EXPOSE 3000

# Use nodemon to watch for changes
CMD ["nodemon", "--legacy-watch", "index.js"]
