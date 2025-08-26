package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lmittmann/tint"

	"github.com/btnmasher/testdj/internal/dj"
	"github.com/btnmasher/testdj/internal/shared"
	"github.com/btnmasher/testdj/internal/sse"
	"github.com/btnmasher/testdj/internal/templates"
)

const (
	ContextManager = "manager"
	ContextLobby   = "lobby"
	ContextUser    = "user"
	ContextLogger  = "logger"
)

const MaxNameLength = 20

var ignoredPaths = []string{
	"/heartbeat",
	"/logout",
	"/invite",
}

func shouldIgnoreLobbyParam(path string) bool {
	for p := range slices.Values(ignoredPaths) {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

func setContentTypeHTML(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
}

func respondWithToast(message, kind string, w http.ResponseWriter) {
	w.Header().Set("HX-Trigger", fmt.Sprintf(`{"toast":{"message":"%s","type":"%s"}}`, message, kind))
}

func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	// behind proxies/tunnels:
	if strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		return true
	}
	// Cloudflare also sets CF-Visitor: {"scheme":"https"}
	if strings.Contains(strings.ToLower(r.Header.Get("Cf-Visitor")), "https") {
		return true
	}
	return false
}

func InjectLogger(logger *slog.Logger) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ContextLogger, logger)))
		})
	}
}

func InjectManager(manager *dj.LobbyManager) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ContextManager, manager)))
		})
	}
}

func InjectSession() func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			logger := mustGetLogger(r)

			manager, exists := r.Context().Value(ContextManager).(*dj.LobbyManager)
			if !exists {
				panic("manager not found on request context")
			}

			cookie, _ := r.Cookie("session_id")
			var sessionID string
			if cookie != nil && cookie.Value != "" {
				sessionID = cookie.Value
			}

			var user *dj.User
			if sessionID != "" {
				var found bool
				user, found = manager.UsersBySessionID.Get(sessionID)
				if !found {
					http.SetCookie(w, &http.Cookie{
						Name:     "session_id",
						Value:    "",
						Path:     "/",
						HttpOnly: true,
						Secure:   isHTTPS(r),
						SameSite: http.SameSiteStrictMode,
						MaxAge:   -1, // delete immediately
						Expires:  time.Unix(0, 0),
					})
					handleErrorRedirect(w, r, "Session Expired")
					return
				}
			}

			lobbyID := chi.URLParam(r, "lobbyId")
			var lobby *dj.Lobby
			var ok bool
			if lobbyID != "" {
				lobby, ok = manager.GetLobby(lobbyID)
				if !ok && !shouldIgnoreLobbyParam(r.URL.Path) {
					templates.ErrorPage("Invalid Lobby code", "The lobby you’re trying to join doesn’t exist or has expired.").Render(r.Context(), w)
					return
				}
			} else if user != nil && user.LobbyID != "" {
				lobby, ok = manager.GetLobby(user.LobbyID)
				if !ok {
					templates.ErrorPage("Invalid Lobby code", "The lobby you’re trying to join doesn’t exist or has expired.").Render(r.Context(), w)
					return
				}
			}

			if lobby != nil {
				r = r.WithContext(context.WithValue(r.Context(), ContextLobby, lobby))
			}

			if user != nil {
				ip, ipErr := shared.ParseHost(r.RemoteAddr)
				if ipErr != nil {
					logger.Warn("Error parsing host", tint.Err(ipErr))
					respondWithToast("Request Error", "error", w)
					http.Error(w, "invalid host", http.StatusBadRequest)
				}

				// Additionally, ensure one session per IP:
				globalUser, exists := manager.UsersByIP.Get(ip)
				if exists && globalUser.ID != user.ID {
					http.SetCookie(w, &http.Cookie{
						Name:     "session_id",
						Value:    "",
						Path:     "/",
						HttpOnly: true,
						Secure:   isHTTPS(r),
						SameSite: http.SameSiteStrictMode,
						MaxAge:   -1, // delete immediately
						Expires:  time.Unix(0, 0),
					})

					handleErrorRedirect(w, r, "Invalid User")
					return
				}

				r = r.WithContext(context.WithValue(r.Context(), ContextUser, user))
			}

			next.ServeHTTP(w, r)
		})
	}
}

func handleErrorRedirect(w http.ResponseWriter, r *http.Request, message string) {
	logger := mustGetLogger(r)

	respondWithToast(message, "error", w)
	if strings.HasPrefix(r.URL.Path, "/lobby") {
		w.Header().Set("HX-Redirect", "/")
		http.Redirect(w, r, "/", http.StatusSeeOther)
	} else if strings.HasPrefix(r.URL.Path, "/sse") {
		w.Header().Set("Access-Control-Expose-Headers", "Content-Type")
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		rc := http.NewResponseController(w)
		w.WriteHeader(http.StatusOK)
		err := rc.Flush()
		if err != nil {
			logger.Warn("Could not send SSE status header", tint.Err(err))
			return
		}

		logger.Debug("Sending SSE Redirect error", slog.String("message", message))

		fmt.Fprintf(w, "event: toast\ndata: %s\n\n", fmt.Sprintf(`{"toast":{"message":"%s","type":"error"}}`, message))
		fmt.Fprint(w, "event: redirect\ndata: /\n\n")

		err = rc.Flush()
		if err != nil {
			logger.Warn("Could not send SSE redirect", tint.Err(err))
			return
		}
		time.Sleep(2 * time.Second)
	} else {
		http.Redirect(w, r, "/", http.StatusSeeOther)
	}
}

func WithLobbyAndUser(handler func(lobby *dj.Lobby, user *dj.User, w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		lobby, ok := r.Context().Value(ContextLobby).(*dj.Lobby)
		if !ok {
			handleErrorRedirect(w, r, "Invalid Lobby")
			return
		}

		user, ok := r.Context().Value(ContextUser).(*dj.User)
		if !ok {
			http.Redirect(w, r, fmt.Sprintf("/invite/%s", lobby.ID), http.StatusSeeOther)
			return
		}

		handler(lobby, user, w, r)
	}
}

func HandleLanding(w http.ResponseWriter, r *http.Request) {
	setContentTypeHTML(w)
	templates.Index().Render(r.Context(), w)
}

func HandleSSE(w http.ResponseWriter, r *http.Request) {
	logger := mustGetLogger(r).With("service", "event-source")

	user, ok := r.Context().Value(ContextUser).(*dj.User)
	if !ok {
		logger.Error("User not found on request context")
		handleErrorRedirect(w, r, "Invalid User")
		return
	}

	rc := http.NewResponseController(w)

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Type")
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ctx, cancel := context.WithCancelCause(r.Context())

	client := &sse.Client{
		ID:      user.ID,
		Writer:  w,
		Flusher: rc,
		Context: ctx,
		Cancel:  cancel,
		Log:     logger.With("userID", user.ID),
	}

	client.Lock()
	user.SSE = client
	client.Unlock()

	w.WriteHeader(http.StatusOK)
	err := rc.Flush()
	if err != nil {
		logger.Error("Flush error", tint.Err(err))
	}

	logger.Info("Connection started", user.Log())

	ticker := time.NewTicker(60 * time.Second) // heartbeat
	defer ticker.Stop()

keepAlive:
	for {
		select {
		case <-ctx.Done():
			break keepAlive
		case t := <-ticker.C:
			fmt.Fprintf(w, ": ping %d\n\n", t.Unix())
			err = rc.Flush()
			if err != nil {
				logger.Error("Flush error", tint.Err(err))
			}
		}
	}

	logger.Info("Connection closed", tint.Err(ctx.Err()))

	client.Lock()
	user.SSE = nil
	client.Unlock()
}

func HandleCreateLobby(w http.ResponseWriter, r *http.Request) {
	logger := mustGetLogger(r)

	name := r.FormValue("name")
	if name == "" || len(name) > MaxNameLength || !nameRegex.MatchString(name) {
		respondWithToast("Invalid User Name", "error", w)
		http.Error(w, "invalid user name", http.StatusBadRequest)
		return
	}

	manager, ok := r.Context().Value(ContextManager).(*dj.LobbyManager)
	if !ok {
		respondWithToast("Lobby Manager Error", "error", w)
		http.Error(w, "lobby manager error", http.StatusInternalServerError)
		return
	}

	if manager.Lobbies.Length() >= manager.MaxLobbies {
		respondWithToast("Lobby Limit Exceeded", "error", w)
		http.Error(w, "lobby limit exceeded", http.StatusServiceUnavailable)
		return
	}

	ip, ipErr := shared.ParseHost(r.RemoteAddr)
	if ipErr != nil {
		logger.Warn("Error parsing host", tint.Err(ipErr))
		respondWithToast("Request Error", "error", w)
		http.Error(w, "invalid host", http.StatusBadRequest)
	}

	var sessionId string
	cookie, _ := r.Cookie("session_id")
	if cookie != nil {
		sessionId = cookie.Value
	}

	manager.CleanExistingSessions(sessionId, ip)

	user := manager.NewUser(name, ip)

	mode := r.FormValue("mode")
	if mode != "linear" && mode != "shuffle" {
		mode = "linear"
	}

	limit := 5
	fmt.Sscanf(r.FormValue("limit"), "%d", &limit)
	if limit < 1 || limit > 20 {
		limit = 5
	}

	lobby := manager.NewLobby(mode, limit, ip)

	http.SetCookie(w, &http.Cookie{
		Name:     "session_id",
		Value:    user.SessionID,
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   28800,
	})

	lobby.AddUser(user)

	http.Redirect(w, r, fmt.Sprintf("/lobby/%s", lobby.ID), http.StatusSeeOther)
}

func mustGetLogger(r *http.Request) *slog.Logger {
	logger, ok := r.Context().Value(ContextLogger).(*slog.Logger)
	if !ok {
		panic("logger not found on request context")
		return nil
	}

	return logger
}

func HandleInviteLink(w http.ResponseWriter, r *http.Request) {
	lobby, ok := r.Context().Value(ContextLobby).(*dj.Lobby)
	if ok && lobby != nil {
		lobby.Lock()
		defer lobby.Unlock()
	}

	setContentTypeHTML(w)
	templates.JoinLobbyPage(lobby).Render(r.Context(), w)
}

func HandleJoinLobby(w http.ResponseWriter, r *http.Request) {
	logger := mustGetLogger(r)

	manager, exists := r.Context().Value(ContextManager).(*dj.LobbyManager)
	if !exists {
		respondWithToast("could not get lobby manager", "error", w)
		http.Error(w, "could not get lobby manager", http.StatusInternalServerError)
		return
	}

	var lobby *dj.Lobby
	var ok bool
	if lobbyID := r.FormValue("code"); lobbyID != "" {
		// attempt to get from manager by form code
		lobby, ok = manager.GetLobby(lobbyID)
	}

	if !ok {
		// attempt to get from request context (path URL)
		lobby, ok = r.Context().Value(ContextLobby).(*dj.Lobby)
	}

	if !ok {
		// Will render an invalid lobby error page
		setContentTypeHTML(w)
		templates.JoinLobbyPage(nil).Render(r.Context(), w)
		return
	}

	name := r.FormValue("name")
	if name == "" || len(name) > MaxNameLength || !nameRegex.MatchString(name) {
		respondWithToast("Invalid User Name", "error", w)
		http.Error(w, "invalid user name", http.StatusBadRequest)
		return
	}

	ip, ipErr := shared.ParseHost(r.RemoteAddr)
	if ipErr != nil {
		logger.Warn("Error parsing host", tint.Err(ipErr))
		respondWithToast("Request Error", "error", w)
		http.Error(w, "invalid host", http.StatusBadRequest)
	}

	var sessionId string
	cookie, _ := r.Cookie("session_id")
	if cookie != nil {
		sessionId = cookie.Value
	}

	if u, exists := manager.UsersByIP.Get(ip); exists {
		if lobby.UsersBySession.Exists(u.SessionID) && u.SSE != nil {
			setContentTypeHTML(w)
			templates.ErrorPage(
				"Multiple Device Error",
				"You are only allowed to join on one device at a time from the same address.").
				Render(r.Context(), w)
			return
		}
	}

	manager.CleanExistingSessions(sessionId, ip)

	user := manager.NewUser(name, ip)
	lobby.AddUser(user)

	http.SetCookie(w, &http.Cookie{
		Name:     "session_id",
		Value:    user.SessionID,
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   28800,
	})

	lobby.Touch()
	http.Redirect(w, r, fmt.Sprintf("/lobby/%s", lobby.ID), http.StatusSeeOther)
}

func HandleHeartbeat(_ *dj.Lobby, user *dj.User, w http.ResponseWriter, _ *http.Request) {
	user.LastActivity = time.Now()
	w.WriteHeader(http.StatusNoContent)
	return
}

func HandleLogout(_ *dj.Lobby, user *dj.User, w http.ResponseWriter, _ *http.Request) {
	user.LastActivity = time.Now().Add(-25 * time.Second)
	w.WriteHeader(http.StatusNoContent)
	return
}

func HandleLogoutOLD(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     "session_id",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1, // delete immediately
		Expires:  time.Unix(0, 0),
	})

	defer w.WriteHeader(http.StatusOK)

	manager, ok := r.Context().Value(ContextManager).(*dj.LobbyManager)
	if !ok {
		return
	}

	user, ok := r.Context().Value(ContextUser).(*dj.User)
	if !ok {
		return
	}

	if user != nil {
		if lobby, exists := manager.Lobbies.Get(user.LobbyID); exists {
			lobby.RemoveUser(user)
			manager.UsersBySessionID.Delete(user.SessionID)
			manager.UsersByIP.Delete(user.IP)
		}
	}

	return
}

func HandleLobbyPage(lobby *dj.Lobby, user *dj.User, w http.ResponseWriter, r *http.Request) {
	manager, ok := r.Context().Value(ContextManager).(*dj.LobbyManager)
	if !ok {
		respondWithToast("could not get lobby manager", "error", w)
		return
	}

	setContentTypeHTML(w)

	lobby.Lock()
	defer lobby.Unlock()

	if u, exists := manager.UsersByIP.Get(user.IP); exists {
		if lobby.UsersBySession.Exists(u.SessionID) && u.SSE != nil {
			templates.ErrorPage(
				"Multiple Device Error",
				"You are only allowed to join on one device at a time from the same address.").
				Render(r.Context(), w)
			return
		}
	}

	lobby.Touch()

	user.LastActivity = time.Now()
	templates.LobbyPage(lobby, user).Render(r.Context(), w)
}

func HandleAddVideo(lobby *dj.Lobby, user *dj.User, w http.ResponseWriter, r *http.Request) {
	exp := user.MutedUntil.Sub(time.Now())
	if exp > 0 {
		respondWithToast(fmt.Sprintf("You are muted for the next %v.", exp.Round(time.Second)), "error", w)
		http.Error(w, "user muted", http.StatusForbidden)
		return
	}

	videoId, ok := validateYTUrl(strings.TrimSpace(r.FormValue("url")))
	if !ok {
		respondWithToast("Invalid YouTube link", "error", w)
		http.Error(w, "invalid link", http.StatusBadRequest)
		return
	}

	var opt FetchOption
	useScrape, set := os.LookupEnv("USE_SCRAPE")
	if !set || useScrape == "true" { // default true to scrape
		opt = opt.Set(UseScrapeFetch)
	}

	title, dur, err := fetchVideoMeta(r.Context(), videoId, opt.Set(UseDataAPI))
	if err != nil {
		if errors.Is(err, ErrAgeRestircted) {
			respondWithToast("Cannot add age restricted video", "error", w)
			http.Error(w, "cannot add age restricted video", http.StatusForbidden)
			return
		}

		if logger, exists := r.Context().Value(ContextLogger).(*slog.Logger); exists {
			logger.Error("Error fetching video metadata for video", slog.String("videoId", videoId), tint.Err(err))
		}
		respondWithToast("Failed to fetch video metadata", "error", w)
		http.Error(w, "failed to fetch video metadata", http.StatusInternalServerError)
		return
	}

	if dur > time.Minute*10 {
		respondWithToast("Videos longer than 10 minutes are not allowed", "error", w)
		http.Error(w, "video too long", http.StatusBadRequest)
		return
	}

	if lobby.PlayedVideos.Exists(videoId) {
		respondWithToast("Video already played in last hour", "error", w)
		http.Error(w, "duplicate", http.StatusConflict)
		return
	}

	if lobby.CheckVideoQueued(videoId) {
		respondWithToast("Video already in queue", "error", w)
		http.Error(w, "already queued", http.StatusConflict)
		return
	}

	if lobby.CheckUserVideoLimit(user) {
		respondWithToast("You've reached your video submission limit", "error", w)
		http.Error(w, "limit reached", http.StatusForbidden)
		return
	}

	lobby.AddVideo(&dj.Video{
		ID:            videoId,
		Title:         title,
		URL:           fmt.Sprintf("https://www.youtube.com/embed/%s?autoplay=1", videoId),
		SubmitterID:   user.ID,
		SubmitterName: user.Name,
		Duration:      dur,
	})

	respondWithToast("Video added!", "success", w)
	w.WriteHeader(http.StatusCreated)
}

func HandleLobbyUsers(lobby *dj.Lobby, user *dj.User, w http.ResponseWriter, r *http.Request) {
	lobby.Lock()
	defer lobby.Unlock()

	setContentTypeHTML(w)
	templates.UsersPartial(lobby, user).Render(r.Context(), w)
}

func HandleLobbyPlaylist(w http.ResponseWriter, r *http.Request) {
	lobby, ok := r.Context().Value(ContextLobby).(*dj.Lobby)
	if !ok {
		respondWithToast("Invalid Lobby", "error", w)
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	lobby.Lock()
	defer lobby.Unlock()

	setContentTypeHTML(w)
	templates.PlaylistPartial(lobby).Render(r.Context(), w)
}

func HandleLobbyHistory(w http.ResponseWriter, r *http.Request) {
	lobby, ok := r.Context().Value(ContextLobby).(*dj.Lobby)
	if !ok {
		respondWithToast("Invalid Lobby", "error", w)
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	lobby.Lock()
	defer lobby.Unlock()

	setContentTypeHTML(w)
	templates.HistoryPartial(lobby).Render(r.Context(), w)
}

func HandleLobbyVideo(w http.ResponseWriter, r *http.Request) {
	lobby, ok := r.Context().Value(ContextLobby).(*dj.Lobby)
	if !ok {
		respondWithToast("Invalid Lobby", "error", w)
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	lobby.Lock()
	defer lobby.Unlock()

	setContentTypeHTML(w)
	templates.VideoPartial(lobby).Render(r.Context(), w)
}

func HandleLobbyVotes(lobby *dj.Lobby, user *dj.User, w http.ResponseWriter, r *http.Request) {
	lobby.Lock()
	defer lobby.Unlock()

	setContentTypeHTML(w)
	templates.VotesPartial(lobby, user).Render(r.Context(), w)
}

func HandleVoteMuteStart(lobby *dj.Lobby, user *dj.User, w http.ResponseWriter, r *http.Request) {
	targetID := r.FormValue("target")

	lobby.Lock()
	if lobby.VoteMute.Active {
		lobby.Unlock()
		respondWithToast("A vote to mute is already pending", "error", w)
		http.Error(w, "vote already active", http.StatusConflict)
		return
	}

	if user.ID == targetID {
		lobby.Unlock()
		respondWithToast("Cannot vote to mute yourself", "error", w)
		http.Error(w, "starting vote mute for self not allowed", http.StatusForbidden)
		return
	}
	lobby.Unlock()

	if cd, ok := lobby.MuteCooldownsByIP.Get(user.IP); ok {
		if time.Now().Before(cd) {
			respondWithToast("You are on cooldown to start a mute vote", "error", w)
			http.Error(w, "Cooldown active", http.StatusForbidden)
			return
		}
	}

	if !lobby.StartVoteMute(user, targetID) {
		respondWithToast("Cannot vote to mute invalid User", "error", w)
		http.Error(w, "invalid vote target", http.StatusBadRequest)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func HandleVoteMuteSubmit(lobby *dj.Lobby, user *dj.User, w http.ResponseWriter, r *http.Request) {
	vote := r.FormValue("vote")
	if vote == "" || (vote != "yes" && vote != "no") {
		respondWithToast("Invalid vote data", "error", w)
		http.Error(w, "invalid vote data", http.StatusBadRequest)
		return
	}

	if !lobby.RecordMuteVote(user, vote) {
		respondWithToast("Vote expired or invalid", "error", w)
		http.Error(w, "no active mute vote", http.StatusConflict)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func HandleVoteSkipStart(lobby *dj.Lobby, user *dj.User, w http.ResponseWriter, _ *http.Request) {
	lobby.Lock()
	if lobby.CurrentVideo == nil {
		lobby.Unlock()
		respondWithToast("There is no current video playing", "error", w)
		http.Error(w, "no current video playing", http.StatusBadRequest)
		return
	}

	if lobby.CurrentVideo.WasVoted {
		lobby.Unlock()
		respondWithToast("This video already survived a vote skip", "error", w)
		http.Error(w, "video already survived vote skip", http.StatusBadRequest)
		return
	}

	lobby.Unlock()

	if lobby.Users.Length() < 2 {
		lobby.Lock()
		lobby.CurrentVideo.WasSkipped = true
		lobby.PickNextVideo()
		lobby.Unlock()
		respondWithToast("Vote to skip automatically succeeded", "success", w)
		w.WriteHeader(http.StatusCreated)
		return
	}

	if !lobby.StartVoteSkip(user) {
		respondWithToast("Vote expired or invalid", "error", w)
		http.Error(w, "vote invalid", http.StatusConflict)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func HandleVoteSkipSubmit(lobby *dj.Lobby, user *dj.User, w http.ResponseWriter, r *http.Request) {
	vote := r.FormValue("vote")
	if vote == "" {
		respondWithToast("Invalid vote data", "error", w)
		http.Error(w, "invalid vote data", http.StatusBadRequest)
		return
	}

	if !lobby.RecordSkipVote(user, vote) {
		respondWithToast("Vote expired or invalid", "error", w)
		http.Error(w, "vote invalid", http.StatusConflict)
		return
	}

	w.WriteHeader(http.StatusCreated)
}
