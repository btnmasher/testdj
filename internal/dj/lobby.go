package dj

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/btnmasher/safemap"

	"github.com/btnmasher/testdj/internal/shared"
	"github.com/btnmasher/testdj/internal/sse"
)

type Lobby struct {
	sync.Mutex
	ID                string
	Mode              string // "linear" or "shuffle"
	CreatorIP         string
	LobbyQueueLimit   int
	UserQueueLimit    int
	CreatedAt         time.Time
	VideoStart        time.Time
	ExpiresAt         time.Time
	Users             safemap.SafeMap[string, *User]
	UsersBySession    safemap.SafeMap[string, *User]
	MutesByIP         safemap.SafeMap[string, time.Time]
	MuteCooldownsByIP safemap.SafeMap[string, time.Time]
	Videos            []*Video
	CurrentVideo      *Video
	PlayedVideos      safemap.SafeMap[string, time.Time]
	VoteSkip          VoteSkipStatus
	VoteMute          VoteMuteStatus

	nextTimer          *time.Timer
	voteSkipTimer      *time.Timer
	voteMuteTimer      *time.Timer
	expiryTimer        *time.Timer
	muteExpiryTicker   *time.Ticker
	videoCleanupTicker *time.Ticker

	log     *slog.Logger
	Manager *LobbyManager
	Cancel  context.CancelFunc
}

type User struct {
	ID            string
	Name          string
	IP            string
	LobbyID       string
	SessionID     string
	MutedUntil    time.Time
	LastActivity  time.Time
	PendingLogout time.Time
	SSE           *sse.Client
}

type Video struct {
	ID            string
	URL           string
	Title         string
	SubmitterID   string
	SubmitterName string
	Duration      time.Duration
}

var LobbyExpired = errors.New("lobby expired")
var UserTimeout = errors.New("user timeout")

const (
	LobbyIDLength   = 7
	UserIDLength    = 9
	SessionIDLength = 12
)

func (m *LobbyManager) NewUser(name, ip string) *User {
	user := &User{
		ID:           shared.GenerateID(UserIDLength),
		SessionID:    shared.GenerateID(SessionIDLength),
		Name:         name,
		IP:           ip,
		LastActivity: time.Now(),
	}
	m.UsersByIP.Set(user.IP, user)
	m.UsersBySessionID.Set(user.SessionID, user)

	return user
}

func (m *LobbyManager) NewLobby(mode string, maxQueue int, creatorIP string) *Lobby {
	now := time.Now()
	id := shared.GenerateID(LobbyIDLength)
	log := m.log.With("service", "lobby", "LobbyID", id)

	l := &Lobby{
		ID:                id,
		Mode:              mode,
		UserQueueLimit:    maxQueue,
		Users:             safemap.NewMutexMap[string, *User](),
		UsersBySession:    safemap.NewMutexMap[string, *User](),
		MutesByIP:         safemap.NewMutexMap[string, time.Time](),
		Videos:            []*Video{},
		PlayedVideos:      safemap.NewMutexMap[string, time.Time](),
		MuteCooldownsByIP: safemap.NewMutexMap[string, time.Time](),
		VoteSkip: VoteSkipStatus{
			YesVotes: safemap.NewMutexMap[string, bool](),
			NoVotes:  safemap.NewMutexMap[string, bool](),
		},
		VoteMute: VoteMuteStatus{
			YesVotes: safemap.NewMutexMap[string, bool](),
			NoVotes:  safemap.NewMutexMap[string, bool](),
		},
		CreatorIP:          creatorIP,
		CreatedAt:          now,
		ExpiresAt:          now.Add(1 * time.Hour),
		nextTimer:          time.NewTimer(0),
		voteSkipTimer:      time.NewTimer(0),
		voteMuteTimer:      time.NewTimer(0),
		expiryTimer:        time.NewTimer(1 * time.Hour),
		muteExpiryTicker:   time.NewTicker(5 * time.Second),
		videoCleanupTicker: time.NewTicker(1 * time.Minute),
		log:                log,
	}

	log.Debug("New lobby created")

	cancelCtx, cancel := context.WithCancel(m.ctx)
	l.Cancel = cancel

	// flush out the newly initialized timer ticks
	<-l.nextTimer.C
	<-l.voteSkipTimer.C
	<-l.voteMuteTimer.C
	go l.timerMinder(cancelCtx)

	m.AddLobby(l)
	return l
}

func (l *Lobby) Touch() {
	l.expiryTimer.Stop()
	l.ExpiresAt = time.Now().Add(1 * time.Hour)
	l.expiryTimer.Reset(1 * time.Hour)
}

func (l *Lobby) Expire() {
	l.log.Info("Lobby Expired")
	l.Broadcast("lobby_expired", "")
	for user := range l.Users.Values() {
		if user.SSE != nil {
			user.SSE.Cancel(LobbyExpired)
		}
	}
	l.Users.Clear()
	l.Manager.RemoveLobby(l)
}

func (l *Lobby) Broadcast(event, data string) {
	l.log.With("func", "Broadcast").
		Debug("Broadcasting message", sse.EventEntry(event, data))
	for user := range l.Users.Values() {
		if user.SSE != nil {
			user.SSE.Send(event, data)
		}
	}
}

func (l *Lobby) AddUser(user *User) {
	dupCount := 1
	for u := range l.Users.Values() {
		if strings.ToLower(u.Name) == strings.ToLower(user.Name) {
			dupCount++
		}
	}

	if dupCount > 1 {
		user.Name = fmt.Sprintf("%s#%d", user.Name, dupCount)
	}

	user.LobbyID = l.ID
	l.Users.Set(user.ID, user)
	l.UsersBySession.Set(user.SessionID, user)

	if mute, exists := l.MutesByIP.Get(user.IP); exists {
		user.MutedUntil = mute
	}

	l.log.With("func", "AddUser").
		Debug("Added User", user.Log())

	l.Broadcast("users_update", "")
}

func (l *Lobby) RemoveUser(user *User) {
	if l.Users.Delete(user.ID) {
		l.log.With("func", "RemoveUser").
			Debug("Removing User", user.Log())

		if user.SSE != nil && user.SSE.Context.Err() == nil {
			user.SSE.Send("redirect", "/")
			user.SSE.Cancel(UserTimeout)
		}

		l.Broadcast("users_update", "")
	}
}

func (l *Lobby) CheckVideoQueued(videoId string) bool {
	l.Lock()
	defer l.Unlock()

	for _, v := range l.Videos {
		if v.ID == videoId {
			return true
		}
	}

	return false
}

func (l *Lobby) AddVideo(video *Video) {
	l.Lock()
	defer l.Unlock()

	log := l.log.With("func", "AddVideo", video.Log())

	l.Videos = append(l.Videos, video)
	if l.CurrentVideo == nil {
		log.Debug("Video added with none currently playing, advancing playlist")
		l.PickNextVideo()
	} else {
		log.Debug("Video added")
		l.Broadcast("playlist_update", "")
	}

	l.Touch()
}

func (l *Lobby) CheckUserVideoLimit(user *User) bool {
	l.Lock()
	defer l.Unlock()

	count := 0
	for _, v := range l.Videos {
		if v.SubmitterID == user.ID {
			count++
		}
	}

	return count >= l.UserQueueLimit
}

func (l *Lobby) timerMinder(ctx context.Context) {
minderLoop:
	for {
		select {
		case <-ctx.Done():
			break minderLoop
		case <-l.expiryTimer.C:
			l.Expire()
			break minderLoop
		case <-l.nextTimer.C:
			go l.PickNextVideo()
		case <-l.voteSkipTimer.C:
			go l.CalcVoteSkipResult()
		case <-l.voteMuteTimer.C:
			go l.CalcVoteMuteResult()
		case <-l.muteExpiryTicker.C:
			go l.CleanupMuteExpirations()
		case <-l.videoCleanupTicker.C:
			go l.CleanupPlayedVideos()
		}
	}

	l.expiryTimer.Stop()
	l.nextTimer.Stop()
	l.voteSkipTimer.Stop()
	l.voteMuteTimer.Stop()
	l.videoCleanupTicker.Stop()
}

func (l *Lobby) CleanupMuteExpirations() {
	log := l.log.With("func", "CleanupMuteExpirations")

	now := time.Now()
	cdsToDelete := make([]string, 0)
	for ip, exp := range l.MuteCooldownsByIP.All() {
		if now.After(exp) {
			cdsToDelete = append(cdsToDelete, ip)
		}
	}

	mutesToDelete := make([]string, 0)
	for ip, exp := range l.MutesByIP.All() {
		if now.After(exp) {
			mutesToDelete = append(mutesToDelete, ip)
		}
	}

	if len(mutesToDelete) > 0 {
		log.Debug("Deleting expired mute cooldowns", slog.Any("IPs", cdsToDelete))
	}

	for _, ip := range cdsToDelete {
		l.MuteCooldownsByIP.Delete(ip)
	}

	if len(mutesToDelete) > 0 {
		log.Debug("Deleting expired mutes", slog.Any("IPs", mutesToDelete))
	}

	for _, ip := range mutesToDelete {
		l.MutesByIP.Delete(ip)
	}

	if len(cdsToDelete) > 0 || len(mutesToDelete) > 0 {
		l.Broadcast("users_update", "")
	}
}

func (l *Lobby) CleanupPlayedVideos() {
	log := l.log.With("func", "CleanupPlayedVideos")

	now := time.Now()
	vidsToDelete := make([]string, 0)
	for vid, exp := range l.PlayedVideos.All() {
		if now.After(exp) {
			vidsToDelete = append(vidsToDelete, vid)
		}
	}

	if len(vidsToDelete) > 0 {
		log.Debug("Deleting videos from play cooldown list", slog.Any("IDs", vidsToDelete))
	}

	for _, vid := range vidsToDelete {
		l.PlayedVideos.Delete(vid)
	}
}

func (l *Lobby) PickNextVideo() {
	log := l.log.With("func", "PickNextVideo")

	if l.nextTimer != nil {
		l.nextTimer.Stop()
	}

	// Cancel any vote skip if active
	if l.VoteSkip.Active {
		log.Debug("Vote skip active during video selection, cancelling")
		l.voteSkipTimer.Stop()
		l.VoteSkip.Active = false
		l.VoteSkip.NoVotes.Clear()
		l.VoteSkip.YesVotes.Clear()
		l.VoteSkip.VideoID = ""
		l.VoteSkip.StartedAt = time.Time{}
	}

	if len(l.Videos) == 0 {
		l.CurrentVideo = nil
		log.Debug("No video to select, queue is empty")
		l.Broadcast("video_update", "")
		return
	}

	var idx int
	if l.Mode == "shuffle" {
		idx = rand.Intn(len(l.Videos))
	}

	next := l.Videos[idx]

	// Remove from playlist and set played
	l.Videos = append(l.Videos[:idx], l.Videos[idx+1:]...)
	l.PlayedVideos.Set(next.ID, time.Now().Add(time.Hour))

	// Set current and signal change
	l.CurrentVideo = next
	l.VideoStart = time.Now()
	state := map[string]any{
		"url":      l.CurrentVideo.URL,
		"mode":     l.Mode,
		"playlist": l.Videos,
	}

	log.Debug("Next video selected", next.Log())

	data, _ := json.Marshal(state)
	l.Broadcast("video_update", string(data))

	l.nextTimer.Reset(l.CurrentVideo.Duration)
}
