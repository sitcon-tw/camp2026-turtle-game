# Turtle Game

Rust backend and Vite/React frontend for the turtle game.

## Prerequisites

- Rust toolchain with Cargo
- Node.js with pnpm
- Docker, optional

## Local Development

Install dependencies:

```bash
make install
```

Start the backend and frontend together:

```bash
make dev
```

Then open <http://localhost:5173>.

The frontend dev server proxies `/api`, `/healthz`, and `/readyz` to the backend at <http://127.0.0.1:3000>.

## Docker Development

Start both services in containers:

```bash
make docker-up
```

Then open <http://localhost:5173>.

Stop the containers:

```bash
make docker-down
```

Docker Compose uses named volumes for Cargo build output, frontend dependencies, and pnpm cache so repeated starts are faster.

## Useful Commands

```bash
make backend-dev     # backend only
make frontend-dev    # frontend only
make test            # backend tests and frontend production build
```
