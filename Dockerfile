    # Use the official Node.js image.
    FROM node:20

    # Create and change to the app directory.
    WORKDIR /usr/src/app

    # Copy application dependency manifests to the container image.
    COPY package*.json ./

    # Install production dependencies.
    RUN npm install --only=production

    # Copy local code to the container image.
    COPY . .

    # Install Puppeteer dependencies
    RUN apt-get update && apt-get install -y \
        wget \
        --no-install-recommends \
        && apt-get clean \
        && rm -rf /var/lib/apt/lists/*

    # Run the web service on container startup.
    CMD [ "npm", "start" ]