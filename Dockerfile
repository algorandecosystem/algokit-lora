# Build stage
FROM node:22-slim AS builder

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    libpng-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files AND patches directory (needed for postinstall)
COPY package*.json ./
COPY patches/ ./patches/

# Install dependencies
# Canvas may fail to build from source but it's optional, npm will continue
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage with Caddy
FROM caddy:2-alpine

# Copy built files from builder
COPY --from=builder /app/dist /usr/share/caddy

EXPOSE 80
EXPOSE 443

CMD ["caddy", "file-server", "--root", "/usr/share/caddy", "--listen", ":80"]
