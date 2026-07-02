FROM rust:1-bookworm AS builder

WORKDIR /app

COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src

RUN cargo build --release --locked

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/backend /usr/local/bin/backend

ENV APP_HOST=0.0.0.0
ENV APP_PORT=3000
ENV RUST_LOG=backend=info

EXPOSE 3000

CMD ["backend"]
