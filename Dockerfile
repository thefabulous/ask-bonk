# Base image with Node.js
FROM node:22-slim

# Install system dependencies (rarely change - cached layer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    openssh-client \
    jq \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install global Node.js tools (cached layer)
RUN npm install -g \
    typescript \
    tsx \
    && npm cache clean --force

# Set up git config
RUN git config --global init.defaultBranch main \
    && git config --global advice.detachedHead false

# Create workspace directory
RUN mkdir -p /home/user/workspace
WORKDIR /home/user/workspace

# Default command
CMD ["bash"]
