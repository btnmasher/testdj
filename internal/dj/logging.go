package dj

import (
	"log/slog"
	"time"
)

func (u *User) Log() slog.Attr {
	return slog.Group("user",
		slog.String("ID", u.ID),
		slog.String("Name", u.Name),
		slog.String("IP", u.IP),
		slog.String("SessionID", u.SessionID),
		slog.String("LobbyID", u.LobbyID),
		slog.Duration("LastActivity", time.Now().Sub(u.LastActivity).Round(time.Second)),
	)
}

func (l *Lobby) Log() slog.Attr {
	return slog.Group("lobby",
		slog.String("ID", l.ID),
		slog.String("CreatorIP", l.CreatorIP),
		slog.Time("CreatedAt", l.CreatedAt),
		slog.Int("UserCount", l.Users.Length()),
		slog.Int("VideoCount", len(l.Videos)),
		slog.Duration("ExpiresIn", l.ExpiresAt.Sub(time.Now()).Round(time.Second)),
	)
}

func (v *Video) Log() slog.Attr {
	return slog.Group("video",
		slog.String("ID", v.ID),
		slog.String("Title", v.Title),
		slog.Duration("Duration", v.Duration),
		slog.String("SubmitterID", v.SubmitterID),
		slog.String("SubmitterName", v.SubmitterName),
	)
}
