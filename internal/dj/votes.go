package dj

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/btnmasher/safemap"
)

type VoteSkipStatus struct {
	VideoID   string
	StartedAt time.Time
	YesVotes  safemap.SafeMap[string, bool]
	NoVotes   safemap.SafeMap[string, bool]
	Active    bool
}

type VoteMuteStatus struct {
	TargetID   string
	TargetName string
	Initiator  string
	StartedAt  time.Time
	YesVotes   safemap.SafeMap[string, bool]
	NoVotes    safemap.SafeMap[string, bool]
	Active     bool
}

func (l *Lobby) StartVoteSkip(user *User) bool {
	log := l.log.With("func", "StartVoteSkip")

	l.Lock()
	defer l.Unlock()
	if l.VoteSkip.Active || l.CurrentVideo == nil {
		log.Debug("Vote skip already active or no video playing")
		return false
	}

	l.VoteSkip.Active = true
	l.VoteSkip.VideoID = l.CurrentVideo.ID
	l.VoteSkip.YesVotes.Set(user.ID, true)
	l.VoteSkip.StartedAt = time.Now()

	l.Broadcast(UpdateVoteSkip, "")
	l.voteSkipTimer.Reset(30 * time.Second)
	return true
}

func (l *Lobby) StartVoteMute(user *User, targetID string) bool {
	log := l.log.With("func", "StartVoteMute", slog.String("MuteTargetID", targetID))

	targetValid := false
	var targetUser *User
	for u := range l.Users.Values() {
		if u.ID == targetID {
			targetValid = true
			targetUser = u
			break
		}
	}

	if !targetValid {
		log.Warn("Target user not found")
		return false
	}

	now := time.Now()

	l.Lock()
	if user.IP != l.CreatorIP {
		log.Debug("Setting vote mute cooldown for user", user.Log())
		l.MuteCooldownsByIP.Set(user.IP, now.Add(5*time.Minute))
	}

	l.VoteMute.Active = true
	l.VoteMute.TargetID = targetUser.ID
	l.VoteMute.TargetName = targetUser.Name
	l.VoteMute.Initiator = user.ID
	l.VoteMute.YesVotes.Set(user.ID, true)
	l.VoteMute.StartedAt = now
	l.Unlock()

	log.Debug("Starting vote mute timer")

	l.Broadcast(UpdateVoteMute, "")
	l.voteMuteTimer.Reset(30 * time.Second)

	return true
}

func (l *Lobby) RecordMuteVote(user *User, vote string) bool {
	log := l.log.With("func", "RecordMuteVote")

	l.Lock()
	if !l.VoteMute.Active {
		l.Unlock()
		return false
	}

	if vote == "yes" {
		l.VoteMute.YesVotes.Set(user.ID, true)
		l.VoteMute.NoVotes.Delete(user.ID)
	} else {
		l.VoteMute.NoVotes.Set(user.ID, true)
		l.VoteMute.YesVotes.Delete(user.ID)
	}

	log.Debug("Recorded vote", slog.String("Vote", vote))

	if l.VoteMute.YesVotes.Length() > (l.Users.Length()+2)/2 {
		log.Debug("Vote reached quorum before timeout, calculating result")
		l.Unlock()
		return l.CalcVoteMuteResult()
	}

	l.BroadcastVoteMuteStatus()
	l.Unlock()
	return true
}

func (l *Lobby) RecordSkipVote(user *User, vote string) bool {
	log := l.log.With("func", "RecordSkipVote")

	l.Lock()
	if !l.VoteSkip.Active || l.VoteSkip.VideoID != l.CurrentVideo.ID {
		l.Unlock()
		return false
	}

	if vote == "yes" {
		l.VoteSkip.YesVotes.Set(user.ID, true)
		l.VoteSkip.NoVotes.Delete(user.ID)
	} else {
		l.VoteSkip.NoVotes.Set(user.ID, true)
		l.VoteSkip.YesVotes.Delete(user.ID)
	}

	log.Debug("Recorded vote", slog.String("Vote", vote))

	if l.VoteSkip.YesVotes.Length() >= (l.Users.Length()+1)/2 {
		log.Debug("Vote reached quorum before timeout, calculating result")
		l.Unlock()
		return l.CalcVoteSkipResult()
	}

	l.BroadcastVoteSkipStatus()
	l.Unlock()
	return true
}

func (l *Lobby) BroadcastVoteSkipStatus() {
	if l.VoteSkip.Active {
		l.Broadcast(UpdateVoteSkip, "")
	} else {
		l.Broadcast(UpdateVoteSkipEnd, "")
	}
}

func (l *Lobby) BroadcastVoteMuteStatus() {
	if l.VoteMute.Active {
		l.Broadcast(UpdateVoteMute, "")
	} else {
		l.Broadcast(UpdateVoteMuteEnd, "")
	}
}

func (l *Lobby) CalcVoteSkipResult() bool {
	log := l.log.With("func", "CalcVoteSkipResult")

	l.Lock()
	defer l.Unlock()

	if !l.VoteSkip.Active || l.VoteSkip.VideoID != l.CurrentVideo.ID {
		log.Debug("No vote active to calculate")
		return false
	}

	succeeded := l.VoteSkip.YesVotes.Length() >= 2 && l.VoteSkip.YesVotes.Length() > l.VoteSkip.NoVotes.Length()

	log.Debug("Vote skip result reached", slog.Bool("Succeeded", succeeded))

	l.EndVoteSkip(succeeded)
	return true
}

func (l *Lobby) EndVoteSkip(succeeded bool) {
	l.voteSkipTimer.Stop()

	if l.CurrentVideo != nil {
		if succeeded {
			videoID := l.CurrentVideo.ID
			l.PlayedVideos.Set(videoID, time.Now().Add(time.Hour))
			l.PickNextVideo()
		} else {
			l.CurrentVideo.WasVoted = true
		}
	}

	l.VoteSkip.Active = false
	l.VoteSkip.VideoID = ""
	l.VoteSkip.StartedAt = time.Time{}
	l.VoteSkip.NoVotes.Clear()
	l.VoteSkip.YesVotes.Clear()

	if succeeded {
		l.Broadcast(UpdateVoteSkipEnd, formatToast("Vote to skip passed!", ToastSuccess))
	} else {
		l.Broadcast(UpdateVoteSkipEnd, formatToast("Vote to skip failed.", ToastError))
	}
}

func (l *Lobby) CalcVoteMuteResult() bool {
	log := l.log.With("func", "CalcVoteMuteResult")

	l.Lock()
	defer l.Unlock()

	if !l.VoteMute.Active {
		log.Debug("No vote active to calculate")
		return false
	}

	succeeded := l.VoteMute.YesVotes.Length() >= (l.Users.Length()+1)/2

	log.Debug("Vote mute result reached", slog.Bool("Succeeded", succeeded))

	l.EndVoteMute(succeeded)
	return true
}

func (l *Lobby) EndVoteMute(succeeded bool) {
	l.voteMuteTimer.Stop()

	if succeeded {
		if u, ok := l.Users.Get(l.VoteMute.TargetID); ok {
			exp := time.Now().Add(10 * time.Minute)
			u.MutedUntil = exp
			l.MutesByIP.Set(u.IP, exp)
		}
	}

	name := l.VoteMute.TargetName

	l.VoteMute.Active = false
	l.VoteMute.TargetID = ""
	l.VoteMute.TargetName = ""
	l.VoteMute.Initiator = ""
	l.VoteMute.StartedAt = time.Time{}
	l.VoteMute.NoVotes.Clear()
	l.VoteMute.YesVotes.Clear()

	if succeeded {
		l.Broadcast(UpdateVoteMuteEnd, formatToast(fmt.Sprintf("Vote to mute %s passed!", name), ToastSuccess))
	} else {
		l.Broadcast(UpdateVoteMuteEnd, formatToast(fmt.Sprintf("Vote to mute %s failed.", name), ToastError))
	}
}

const (
	UpdateVoteSkip    = "vote_skip_update"
	UpdateVoteSkipEnd = "vote_skip_end"
	UpdateVoteMute    = "vote_mute_update"
	UpdateVoteMuteEnd = "vote_mute_end"
)

const (
	ToastSuccess = "success"
	ToastError   = "error"
)

func formatToast(message, kind string) string {
	return fmt.Sprintf(`{"toast":{"message":"%s", "type":"%s"}}`, message, kind)
}
