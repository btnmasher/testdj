package dj

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/btnmasher/safemap"
)

const MaxLobbies = 100

type LobbyManager struct {
	sync.Mutex
	Lobbies          safemap.SafeMap[string, *Lobby]
	UsersByIP        safemap.SafeMap[string, *User]
	UsersBySessionID safemap.SafeMap[string, *User]
	MaxLobbies       int

	userCleanupTicker *time.Ticker
	ctx               context.Context
	log               *slog.Logger
}

func NewLobbyManager(ctx context.Context, log *slog.Logger) *LobbyManager {
	m := &LobbyManager{
		Lobbies:           safemap.NewMutexMap[string, *Lobby](),
		UsersByIP:         safemap.NewMutexMap[string, *User](),
		UsersBySessionID:  safemap.NewMutexMap[string, *User](),
		MaxLobbies:        MaxLobbies,
		userCleanupTicker: time.NewTicker(10 * time.Second),
		ctx:               ctx,
		log:               log.With("service", "LobbyManager"),
	}

	go m.timerMinder()

	return m
}

func (m *LobbyManager) timerMinder() {
minderLoop:
	for {
		select {
		case <-m.ctx.Done():
			break minderLoop
		case <-m.userCleanupTicker.C:
			go m.CleanupUsers()
		}
	}

	m.userCleanupTicker.Stop()
}

func (m *LobbyManager) GetLobby(id string) (*Lobby, bool) {
	l, ok := m.Lobbies.Get(id)
	return l, ok
}

func (m *LobbyManager) AddLobby(l *Lobby) {
	m.log.With("func", "AddLobby").
		Debug("Adding lobby to manager", l.Log())

	l.Manager = m
	m.Lobbies.Set(l.ID, l)
}

func (m *LobbyManager) RemoveLobby(l *Lobby) {
	m.log.With("func", "RemoveLobby").
		Debug("Clearing user session and deleting lobby", l.Log())

	l.Cancel()
	users := l.Users.ValuesSlice()
	m.Lobbies.Delete(l.ID)
	for _, user := range users {
		if user.SSE != nil {
			user.SSE.Send("redirect", "/")
			user.SSE.Cancel(LobbyExpired)
		}
		m.UsersByIP.Get(user.ID)
		m.UsersBySessionID.Get(user.SessionID)
	}
}

func (m *LobbyManager) CleanupUsers() {
	now := time.Now()
	m.Lock()
	defer m.Unlock()
	log := m.log.With("func", "CleanupUsers")

	for user := range slices.Values(m.UsersByIP.ValuesSlice()) {
		if now.Sub(user.LastActivity).Seconds() > 35 {
			log.Debug("Found timed out user, removing from lobby", user.Log())
			for lobby := range m.Lobbies.Values() {
				for u := range slices.Values(lobby.Users.ValuesSlice()) {
					if u.IP == user.IP || u.ID == user.ID {
						lobby.RemoveUser(u)
					}
				}
			}

			if lobby, exists := m.Lobbies.Get(user.LobbyID); exists {
				lobby.RemoveUser(user)
			}

			m.UsersBySessionID.Delete(user.SessionID)
			m.UsersByIP.Delete(user.IP)
		}
	}
}

func (m *LobbyManager) CleanExistingSessions(sessionId, ip string) {
	log := m.log.With("func", "CleanExistingSessions")

	if sessionId != "" {
		if u, ok := m.UsersBySessionID.Get(sessionId); ok {
			log.Debug("Found user for session ID, deleting", u.Log())
			if lobby, exists := m.Lobbies.Get(u.LobbyID); exists {
				lobby.RemoveUser(u)
			}
			m.UsersBySessionID.Delete(u.SessionID)
			m.UsersByIP.Delete(u.IP)
		}
	}

	if ip != "" {
		if u, ok := m.UsersByIP.Get(ip); ok {
			log.Debug("Found user for IP, deleting", u.Log())
			if lobby, exists := m.Lobbies.Get(u.LobbyID); exists {
				lobby.RemoveUser(u)
			}
			m.UsersBySessionID.Delete(u.SessionID)
			m.UsersByIP.Delete(u.IP)
		}
	}
}
