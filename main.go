package main

import (
	"compress/flate"
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/dpotapov/slogpfx"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/lmittmann/tint"
	slogchi "github.com/samber/slog-chi"
	"gitlab.com/greyxor/slogor"

	"github.com/btnmasher/testdj/internal/dj"
	"github.com/btnmasher/testdj/internal/service"
	"github.com/btnmasher/testdj/internal/shared"
)

//go:embed static/*
var content embed.FS
var defaultLogger = slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
	Level: slog.LevelInfo,
}))

var ReleaseType = "dev"
var Version = "v0.0.0"
var CommitHash = "unknown"
var Branch = "unknown"
var BuildDate = "unknown"

const defaultPort = "8080"
const defaultLogLevel = slog.LevelInfo

var levelMap = map[string]slog.Level{
	"debug": slog.LevelDebug,
	"info":  slog.LevelInfo,
	"warn":  slog.LevelWarn,
	"error": slog.LevelError,
}

func init() {
	os.Setenv("env", ReleaseType)
	os.Setenv("githash", CommitHash)
}

func getLogLevel() slog.Level {
	if level, set := os.LookupEnv("LOG_LEVEL"); set {
		if l, ok := levelMap[strings.ToLower(level)]; ok {
			return l
		}
	}

	return defaultLogLevel
}

func main() {
	mainCtx, cancelMain := context.WithCancel(context.Background())
	defer cancelMain()

	logLevel := new(slog.LevelVar)
	logLevel.Set(getLogLevel())

	// Use the prefix based on the attribute "service"
	prefixed := slogpfx.NewHandler(
		slogor.NewHandler(os.Stderr, slogor.SetLevel(logLevel), slogor.SetTimeFormat(time.Stamp)),
		&slogpfx.HandlerOptions{
			PrefixKeys: []string{"service"},
		},
	)

	logger := slog.New(prefixed)

	manager := dj.NewLobbyManager(mainCtx, logger)
	staticFiles, fileErr := fs.Sub(content, "static")
	if fileErr != nil {
		logger.Error("could not read embedded static assets", tint.Err(fileErr))
		os.Exit(1)
	}

	r := chi.NewRouter()
	r.Use(
		middleware.Recoverer,
		shared.RealIP,
		middleware.Compress(flate.DefaultCompression),
		slogchi.NewWithFilters(
			logger.With("service", "http"),
			slogchi.IgnoreStatus(http.StatusNoContent),
		),
		service.InjectLogger(logger),
		service.InjectManager(manager),
	)

	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		http.FileServer(http.FS(staticFiles)).ServeHTTP(w, r)
	})

	r.Get("/", service.HandleLanding)
	r.Post("/create", service.HandleCreateLobby)

	r.Group(func(session chi.Router) {
		session.Use(service.InjectSession())

		session.Post("/join", service.HandleJoinLobby)
		session.Post("/join/{lobbyId}", service.HandleJoinLobby)
		session.Get("/invite/{lobbyId}", service.HandleInviteLink)
		session.Get("/sse/{lobbyId}", service.HandleSSE)
		session.Get("/logout", service.WithLobbyAndUser(service.HandleLogout))
		session.Post("/logout", service.WithLobbyAndUser(service.HandleLogout))

		session.Route("/lobby/{lobbyId}", func(lobby chi.Router) {
			lobby.Get("/", service.WithLobbyAndUser(service.HandleLobbyPage))
			lobby.Get("/video", service.HandleLobbyVideo)
			lobby.Get("/playlist", service.HandleLobbyPlaylist)
			lobby.Get("/history", service.HandleLobbyHistory)
			lobby.Post("/heartbeat", service.WithLobbyAndUser(service.HandleHeartbeat))
			lobby.Post("/add", service.WithLobbyAndUser(service.HandleAddVideo))
			lobby.Get("/users", service.WithLobbyAndUser(service.HandleLobbyUsers))
			lobby.Get("/votes", service.WithLobbyAndUser(service.HandleLobbyVotes))
			lobby.Route("/vote", func(vote chi.Router) {
				vote.Post("/skip/start", service.WithLobbyAndUser(service.HandleVoteSkipStart))
				vote.Post("/skip/submit", service.WithLobbyAndUser(service.HandleVoteSkipSubmit))
				vote.Post("/mute/start", service.WithLobbyAndUser(service.HandleVoteMuteStart))
				vote.Post("/mute/submit", service.WithLobbyAndUser(service.HandleVoteMuteSubmit))
			})
		})
	})

	logger = logger.With("service", "main")

	killSig := make(chan os.Signal, 1)

	signal.Notify(killSig, os.Interrupt, syscall.SIGTERM)

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	listenAddr := net.JoinHostPort(os.Getenv("LISTEN_ADDR"), port)
	srv := &http.Server{
		Addr:    listenAddr,
		Handler: r,
	}

	go func() {
		err := srv.ListenAndServe()

		if errors.Is(err, http.ErrServerClosed) {
			logger.Info("Server shutdown complete")
		} else if err != nil {
			logger.Error("Server shutdown with error", tint.Err(err))
			os.Exit(1)
		}
	}()

	logger.Info(fmt.Sprintf("Listening on %s - env: %s", listenAddr, ReleaseType))

	<-killSig

	logger.Info("Shutting down server")
	cancelMain()

	ctx, cancel := context.WithTimeout(mainCtx, 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("Server shutdown with error", tint.Err(err))
	}
}
