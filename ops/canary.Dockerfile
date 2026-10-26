# Qualification image only. Production packaging remains the CARS frontend release.
FROM docker.io/node:24-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
COPY shared ./shared
RUN cd frontend && npm run build
FROM docker.io/nginx:alpine
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/p2ppsr/mountaintops" org.opencontainers.image.revision="$SOURCE_REVISION"
COPY ops/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/build /usr/share/nginx/html
EXPOSE 80
