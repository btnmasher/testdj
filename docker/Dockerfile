# Install tools
FROM golang:1.24-bookworm AS tools

WORKDIR /testdj

COPY Makefile .

ENV GOCACHE=/testdj/cache/go-build

RUN --mount=type=cache,target="/testdj/cache/go-build" make install-tools


# Build app
FROM golang:1.24-bookworm AS builder

WORKDIR /testdj

COPY --from=tools /testdj/tailwindcss ./tailwindcss
COPY --from=tools /go/bin/templ /go/bin/templ

COPY . .

ENV GOCACHE=/testdj/cache/go-build

RUN --mount=type=cache,target="/testdj/cache/go-build" go mod download

RUN make generate

RUN --mount=type=cache,target="/testdj/cache/go-build" make build


# Run app
FROM ubuntu:latest

# Install CA roots
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /testdj/bin/testdj .

CMD ["./testdj"]