# TEST DJ

[![Release Build](https://github.com/btnmasher/testdj/actions/workflows/build_release.yml/badge.svg)](https://github.com/btnmasher/testdj/actions/workflows/build_release.yml)

A shared "watch together" app: create or join a lobby, paste YouTube links, and everyone watches the same queue (mostly) in sync. The lobby can run the playlist in **linear** or **shuffle** mode, and every video (or skip) advances the queue.

Users can:

- Add videos
  - Configurable per-user queue limit between 1 and 20 videos submitted to the active playlist.
  - The same video cannot be re-submitted to the playlist for 1 hour since they were last played.
  - Lobby maximum of 100 videos in the playlist
- **Vote to skip** the currently playing video, or **Vote to mute** a disruptive user for a cooldown period
  - Votes succeed after 30 seconds with simple majority ignoring non-voting users
  - Votes succeed early if full lobby quorum majority is reached

Lobbies are in-memory and auto-expire after 1 hour of inactivity, with a maximum of 100 lobbies.

All assets are embedded in the binary so you can run it as a single executable (or via Docker).

---

## Build & Run (Makefile)

### Install TailwindCSS and Templ

```bash
  make install-tools
```

### Production build

```bash
make build
```
Produces a stripped binary with minified CSS in `./bin/`. Run it and open http://localhost:8080.

### Local/dev build

```bash
make build-dev
```
or

```bash
   make run
```
Builds a development binary (with the race detector) in `./bin/`.

### Docker

Docker Compose configurations live under `docker/`. You can also use the Makefile targets below.

#### Default stack (Cloudflare Tunnel-enabled docker compose)

Add your tokens, keys, and configs to `docker/.env` (see: `docker/.env.EXAMPLE`)

```bash
make docker-build
make docker-up
make docker-down
make docker-logs

```

#### Without Cloudfare Tunnel

```bash
make docker-build-notunnel
make docker-up-notunnel
make docker-down-notunnel
make docker-logs-notunnel
```

#### Cleanup (Both Stacks)
```bash
make docker-clean
```

