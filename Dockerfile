FROM node:18-alpine

# Needed for bcrypt
# RUN apk --no-cache add --virtual builds-deps build-base python2

# Create app directory
RUN mkdir -p /app && chown node:node /app
USER node
WORKDIR /app

# Install dependencies
COPY --chown=node:node package.json yarn.lock ./
RUN yarn --frozen-lockfile --production

# Bundle app source
COPY --chown=node:node src src

# Exports
EXPOSE 8080
CMD [ "node", "src/index.js" ]
