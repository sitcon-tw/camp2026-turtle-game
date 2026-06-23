.PHONY: install dev backend-dev frontend-dev test backend-test frontend-build docker-up docker-down

install:
	cd backend && cargo fetch
	cd frontend && pnpm install

dev:
	$(MAKE) -j2 backend-dev frontend-dev

backend-dev:
	cd backend && cargo run

frontend-dev:
	cd frontend && pnpm dev

test: backend-test frontend-build

backend-test:
	cd backend && cargo test

frontend-build:
	cd frontend && pnpm run build

docker-up:
	docker compose up --build

docker-down:
	docker compose down
