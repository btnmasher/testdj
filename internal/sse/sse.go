package sse

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"

	"github.com/lmittmann/tint"
)

type Client struct {
	sync.Mutex
	ID      string
	Writer  http.ResponseWriter
	Flusher *http.ResponseController
	Context context.Context
	Cancel  context.CancelCauseFunc
	Log     *slog.Logger
}

func EventEntry(event, data string) slog.Attr {
	return slog.Group("message",
		slog.String("type", event),
		slog.String("data", data))
}

func (c *Client) Send(event, data string) {
	log := c.Log.With("func", "Send", slog.String("ClientID", c.ID))
	log.Debug("Sending SSE event", EventEntry(event, data))

	c.Lock()
	defer c.Unlock()

	fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, data)

	err := c.Flusher.Flush()
	if err != nil {
		log.Error("Error sending SSE event", tint.Err(err))
		return
	}

	log.Debug("SSE event sent")
}
