APP_NAME ?= testdj
COMPOSE ?= docker compose
GIT_HASH := $(shell git rev-parse --short HEAD)
GIT_TAG := $(shell test -z "$$(git status --porcelain)" && git describe --tags --exact-match 2>/dev/null || true)
GIT_BRANCH := $(shell git branch --show-current 2>/dev/null || git symbolic-ref --short -q HEAD || git rev-parse --short HEAD)
NOW := $(shell date -u +"%Y-%m-%dT%H-%M-%SZ")

OS := $(shell uname -s | tr '[:upper:]' '[:lower:]')
ARCH := $(shell uname -m)
# Map OS/arch to Tailwind asset names
ifeq ($(OS),darwin)
	OS := macos
endif
ifeq ($(ARCH),x86_64)
	ARCH := x64
endif
ifeq ($(ARCH),amd64)
	ARCH := x64
endif
ifeq ($(ARCH),aarch64)
	ARCH := arm64
endif
ifeq ($(ARCH),arm64)
	ARCH := arm64
endif

TAILWIND_URL := https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-$(OS)-$(ARCH)

help:
	@echo "Targets:"
	@echo "  build                 - Production build (stripped)"
	@echo "  build-dev             - Dev build (race detector)"
	@echo "  run                   - Build dev and run"
	@echo "  generate              - Generates go files and CSS from templates"
	@echo "  generate-dev          - Generates go files and CSS from templates"
	@echo "  templ-generate        - Generates go files from templates"
	@echo "  tailwind-generate     - Generates minified CSS at static/css/style.min.css"
	@echo "  tailwind-generate-dev - Generates unminified CSS at static/css/style.css"
	@echo "  tidy                  - Runs go mod tidy on go.mod"
	@echo "  install-tools         - Download TailwindCSS and Templ"
	@echo "  install-tailwind      - Download TailwindCSS"
	@echo "  install-templ		   - Download Templ"
	@echo "  docker-build          - Build images via docker/docker-compose.yml"
	@echo "  docker-up             - Up via docker/docker-compose.yml"
	@echo "  docker-down           - Down via docker/docker-compose.yml"
	@echo "  docker-logs           - Follow logs via docker/docker-compose.yml"
	@echo "  docker-build-notunnel - Build images via docker/docker-compose-notunnel.yml"
	@echo "  docker-up-notunnel    - Up via docker/docker-compose-notunnel.yml"
	@echo "  docker-down-notunnel  - Down via docker/docker-compose-notunnel.yml"
	@echo "  docker-logs-notunnel  - Follow logs via docker/docker-compose-notunnel.yml"
	@echo "  docker-clean          - Stop both stacks, remove orphans, prune images/volumes"

.PHONY: install-tailwind
install-tailwind:
	@echo "Detected OS: $(OS), ARCH: $(ARCH)"
	@echo "Downloading $(TAILWIND_URL)"
	@if [ ! -f tailwindcss ]; then \
	  curl -fsSL "$(TAILWIND_URL)" -o tailwindcss && chmod +x tailwindcss; \
	else \
	  echo "tailwindcss already present, skipping download"; \
	fi
	@./tailwindcss --help >/dev/null 2>&1
	@echo "✅ TailwindCSS installed"

.PHONY: install-templ
install-templ:
	@if ! command -v templ >/dev/null 2>&1; then \
		echo "Installing templ..."; \
		go install github.com/a-h/templ/cmd/templ@latest; \
	else \
		echo "templ already installed, skipping build"; \
	fi
	@templ version >/dev/null 2>&1
	@echo "✅ Templ installed"

.PHONY: install-tools
install-tools: install-tailwind install-templ
	@echo "✅ Tools installed"

.PHONY: tailwind-generate-dev
tailwind-generate-dev:
	./tailwindcss -i input.css -o static/css/style.css

.PHONY: tailwind-generate
tailwind-generate:
	./tailwindcss -i input.css -o static/css/style.min.css --minify

.PHONY: templ-generate
templ-generate:
	templ generate

.PHONY: tidy
tidy:
	go mod tidy

.PHONY: run
run: build-dev
	./bin/${APP_NAME}

.PHONY: generate
generate: templ-generate tailwind-generate

.PHONY: generate-dev
generate-dev: templ-generate tailwind-generate-dev

.PHONY: build-dev
build-dev: tidy
	go build -race -ldflags "-X main.ReleaseType=dev -X main.Version=$(GIT_TAG) -X main.CommitHash=$(GIT_HASH) -X main.Branch=$(GIT_BRANCH) -X main.BuildDate=$(NOW)" -o ./bin/$(APP_NAME) ./main.go

.PHONY: build
build: tidy
	go build -ldflags "-s -w -X main.ReleaseType=production -X main.Version=$(GIT_TAG) -X main.CommitHash=$(GIT_HASH) -X main.Branch=$(GIT_BRANCH) -X main.BuildDate=$(NOW)" -o ./bin/$(APP_NAME) ./main.go

# ==== Docker (with tunnel) ====
docker-build:
	$(COMPOSE) -f docker/docker-compose.yml build

docker-up:
	$(COMPOSE) -f docker/docker-compose.yml up -d

docker-down:
	$(COMPOSE) -f docker/docker-compose.yml down

docker-logs:
	$(COMPOSE) -f docker/docker-compose.yml logs -f

# ==== Docker (NO tunnel) ====
docker-build-notunnel:
	$(COMPOSE) -f docker/docker-compose-notunnel.yml build

docker-up-notunnel:
	$(COMPOSE) -f docker/docker-compose-notunnel.yml up -d

docker-down-notunnel:
	$(COMPOSE) -f docker/docker-compose-notunnel.yml down

docker-logs-notunnel:
	$(COMPOSE) -f docker/docker-compose-notunnel.yml logs -f

# Stop both stacks, remove orphans, and prune dangling images/volumes
docker-clean:
	$(COMPOSE) -f docker/docker-compose.yml down -v --remove-orphans
	$(COMPOSE) -f docker/docker-compose-notunnel.yml down -v --remove-orphans
	docker image prune -f
	docker volume prune -f