FROM rust:1-bookworm AS build
WORKDIR /src
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake libclang-dev \
 && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd -r -u 10001 og && mkdir -p /data /app/build && chown og /data
COPY --from=build /src/target/release/open-grind-web-server /usr/local/bin/open-grind-web-server
COPY build /app/build
USER og
ENV OG_BIND=0.0.0.0:8787 OG_DATA_DIR=/data OG_STATIC_DIR=/app/build
VOLUME /data
CMD ["open-grind-web-server"]
