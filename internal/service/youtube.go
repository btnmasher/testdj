package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// RegEx Patterns
var (
	youtubeRegex  = regexp.MustCompile(`^(?:https?://)?(?:www\.|m\.)?(?:youtube\.com/watch\?v=|youtu\.be/)([A-Za-z0-9_-]{11})(?:[?&].*)?$`)
	durationRegex = regexp.MustCompile(`(?i)<meta\s+itemprop=(?:"|')duration(?:"|')\s+content=(?:"|')([^"']+)(?:"|')`)
	titleRegex    = regexp.MustCompile(`(?i)<meta\s+(?:name|property)=(?:"|')(?:og:)?title(?:"|')\s+content=(?:"|')([^"']+)(?:"|')`)
	iso8601Regex  = regexp.MustCompile(`PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?`)
	nameRegex     = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9 ]{0,18}[A-Za-z0-9])?$`)
)

// Errors
var (
	ErrAgeRestircted = errors.New("age restircted")
)

type FetchOption int8

const (
	UseScrapeFetch FetchOption = 1 << iota
	UseDataAPI
	UseScrapeBrowser
)

func (o FetchOption) Set(f ...FetchOption) FetchOption {
	newOpt := o
	for _, opt := range f {
		newOpt = newOpt | opt
	}
	return newOpt
}

func (o FetchOption) Has(f FetchOption) bool {
	return o&f == f
}

func fetchVideoMeta(ctx context.Context, videoID string, fetchType FetchOption) (string, time.Duration, error) {
	var title string
	var dur time.Duration
	var scrapeErr error
	var apiErr error

	timeoutCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	switch {
	case fetchType.Has(UseScrapeFetch):
		// Primary path: mobile client emulation
		title, dur, scrapeErr = fetchVideoMetaMobileScrape(timeoutCtx, videoID)
		if scrapeErr == nil && dur > 0 && title != "" {
			return title, dur, nil
		}
		if errors.Is(scrapeErr, ErrAgeRestircted) {
			return "", dur, scrapeErr
		}

		fallthrough
	case fetchType.Has(UseDataAPI):
		// Fallback: official YouTube Data API v3 (requires API key)
		apiKey := strings.TrimSpace(os.Getenv("YT_API_KEY"))
		if apiKey == "" {
			if scrapeErr != nil {
				return "", 0, fmt.Errorf(
					"scrape path failed (%v); official YouTube Data API fallback disabled (set YT_API_KEY environment variable)", scrapeErr,
				)
			}
			return "", 0, errors.New("YouTube Data API disabled (set YT_API_KEY environment variable)")
		}

		title, dur, apiErr = fetchVideoMetaDataAPI(timeoutCtx, videoID, apiKey)
		if apiErr == nil && dur > 0 && title != "" {
			return title, dur, nil
		}

		if errors.Is(scrapeErr, ErrAgeRestircted) {
			return "", dur, scrapeErr
		}
	}

	// Both failed; surface both contexts for logs.
	switch {
	case scrapeErr != nil && apiErr != nil:
		return "", 0, fmt.Errorf("mobile scrape path: %w; official data api: %w", scrapeErr, apiErr)
	case apiErr != nil:
		return "", 0, fmt.Errorf("official data api fallback failed: %w", apiErr)
	default:
		return "", 0, errors.New("failed to obtain metadata")
	}
}

// --- mobile scrape types ---

var (
	userAgent = "com.google.ios.youtube/20.32.4 (iPhone16,2; U; CPU iOS 18_6_0 like Mac OS X; US)"
	swDataURL = "https://www.youtube.com/sw.js_data"
	playerURL = "https://www.youtube.com/youtubei/v1/player"

	iosReqTemplate = iosPlayerRequest{
		ContentCheckOk: true,
		Context: requestContext{
			Client: clientInfo{
				ClientName:       "IOS",
				ClientVersion:    "20.32.4",
				DeviceMake:       "Apple",
				DeviceModel:      "iPhone16,2",
				Platform:         "MOBILE",
				OsName:           "IOS",
				OsVersion:        "18.6.0.22G86",
				Hl:               "en",
				Gl:               "US",
				UtcOffsetMinutes: 0,
			},
		},
	}
)

type clientInfo struct {
	ClientName       string `json:"clientName"`
	ClientVersion    string `json:"clientVersion"`
	DeviceMake       string `json:"deviceMake"`
	DeviceModel      string `json:"deviceModel"`
	Platform         string `json:"platform"`
	OsName           string `json:"osName"`
	OsVersion        string `json:"osVersion"`
	VisitorData      string `json:"visitorData,omitempty"`
	Hl               string `json:"hl"`
	Gl               string `json:"gl"`
	UtcOffsetMinutes int    `json:"utcOffsetMinutes"`
}

type requestContext struct {
	Client clientInfo `json:"client"`
}

type iosPlayerRequest struct {
	VideoID        string         `json:"videoId"`
	ContentCheckOk bool           `json:"contentCheckOk"`
	Context        requestContext `json:"context"`
}

type playerResponse struct {
	VideoDetails struct {
		Title         string `json:"title"`
		LengthSeconds string `json:"lengthSeconds"`
		// Sometimes present (not guaranteed on all variants):
		AgeRestricted bool `json:"ageRestricted"`
	} `json:"videoDetails"`
	StreamingData struct {
		AdaptiveFormats []struct {
			ApproxDurationMs string `json:"approxDurationMs"`
		} `json:"adaptiveFormats"`
	} `json:"streamingData"`

	// Age gating often shows up here:
	PlayabilityStatus struct {
		Status                     string `json:"status"` // e.g. "OK", "UNPLAYABLE", "LOGIN_REQUIRED", "AGE_VERIFICATION_REQUIRED"
		Reason                     string `json:"reason"`
		DesktopLegacyAgeGateReason int    `json:"desktopLegacyAgeGateReason"`
	} `json:"playabilityStatus"`

	// Microformat rating flags:
	Microformat struct {
		PlayerMicroformatRenderer struct {
			IsFamilySafe bool   `json:"isFamilySafe"` // often false for age-restricted
			YTRating     string `json:"ytRating"`     // e.g. "ytAgeRestricted"
		} `json:"playerMicroformatRenderer"`
	} `json:"microformat"`
}

// --- Data API types ---

type ytDataAPIResp struct {
	Items []struct {
		Snippet struct {
			Title string `json:"title"`
		} `json:"snippet"`
		ContentDetails struct {
			Duration      string `json:"duration"` // ISO 8601, e.g. "PT5M19S"
			ContentRating struct {
				YTRating string `json:"ytRating"` // "ytAgeRestricted" or empty
			} `json:"contentRating"`
		} `json:"contentDetails"`
	} `json:"items"`
}

func fetchVideoMetaDataAPI(ctx context.Context, videoID, apiKey string) (string, time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()

	u := "https://www.googleapis.com/youtube/v3/videos" +
		"?part=snippet,contentDetails&id=" + videoID + "&key=" + apiKey

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", 0, fmt.Errorf("data api build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("data api request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", 0, fmt.Errorf("data api %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}

	var out ytDataAPIResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", 0, fmt.Errorf("data api decode: %w", err)
	}

	if len(out.Items) == 0 {
		return "", 0, fmt.Errorf("data api: no items for id %q", videoID)
	}

	if out.AnyAgeRestricted() {
		return "", 0, fmt.Errorf("data api: %w", ErrAgeRestircted)
	}

	title := strings.TrimSpace(out.Items[0].Snippet.Title)
	iso := strings.TrimSpace(out.Items[0].ContentDetails.Duration)

	dur, err := parseISO8601(iso)
	if err != nil {
		return title, 0, fmt.Errorf("data api parse duration %q: %w", iso, err)
	}
	return title, dur, nil
}

// fetchVideoMetaMobileScrape returns the video title and duration by emulating the iOS client.
func fetchVideoMetaMobileScrape(ctx context.Context, videoID string) (string, time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	hc := &http.Client{Timeout: 15 * time.Second}

	visitorData, visitorErr := resolveVisitorData(ctx, hc)
	if visitorErr != nil {
		return "", 0, visitorErr
	}

	// Clone the template, fill in per-call fields
	reqPayload := iosReqTemplate
	reqPayload.VideoID = videoID
	reqPayload.Context.Client.VisitorData = visitorData

	raw, payloadErr := json.Marshal(reqPayload)
	if payloadErr != nil {
		return "", 0, payloadErr
	}

	req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, playerURL, bytes.NewBuffer(raw))
	if reqErr != nil {
		return "", 0, reqErr
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)

	resp, respErr := hc.Do(req)
	if respErr != nil {
		return "", 0, respErr
	}

	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", 0, fmt.Errorf("mobile scrape response %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}

	body, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return "", 0, readErr
	}

	var pr playerResponse
	if jsErr := json.Unmarshal(body, &pr); jsErr != nil {
		return "", 0, jsErr
	}

	if pr.IsAgeRestricted() {
		return "", 0, fmt.Errorf("mobile scrape: %w", ErrAgeRestircted)
	}

	title := strings.TrimSpace(pr.VideoDetails.Title)

	secs := int64(0)
	if s := strings.TrimSpace(pr.VideoDetails.LengthSeconds); s != "" {
		if n, e := strconv.ParseInt(s, 10, 64); e == nil {
			secs = n
		}
	}

	if secs == 0 {
		for _, f := range pr.StreamingData.AdaptiveFormats {
			if f.ApproxDurationMs == "" {
				continue
			}
			msStr := strings.Split(f.ApproxDurationMs, ".")[0]
			if ms, e := strconv.ParseInt(msStr, 10, 64); e == nil && ms > 0 {
				secs = ms / 1000
				break
			}
		}
	}

	if secs == 0 {
		return "", 0, errors.New("duration not found")
	}

	return title, time.Duration(secs) * time.Second, nil
}

func resolveVisitorData(ctx context.Context, hc *http.Client) (string, error) {
	req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, swDataURL, nil)
	if reqErr != nil {
		return "", reqErr
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)

	resp, respErr := hc.Do(req)
	if respErr != nil {
		return "", respErr
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("sw.js_data %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	body := string(bodyBytes)
	if strings.HasPrefix(body, ")]}'") { // XSSI guard
		body = body[4:]
	}

	var v any
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return "", err
	}

	// Navigate [0][2][0][0][13]
	a0, _ := v.([]any)
	if len(a0) == 0 {
		return "", errors.New("unexpected sw.js_data shape (a0)")
	}

	a1, _ := a0[0].([]any)
	if len(a1) < 3 {
		return "", errors.New("unexpected sw.js_data shape (a1)")
	}

	a2, _ := a1[2].([]any)
	if len(a2) < 1 {
		return "", errors.New("unexpected sw.js_data shape (a2)")
	}

	a3, _ := a2[0].([]any)
	if len(a3) < 1 {
		return "", errors.New("unexpected sw.js_data shape (a3)")
	}

	a4, _ := a3[0].([]any)
	if len(a4) < 14 {
		return "", errors.New("unexpected sw.js_data shape (a4)")
	}

	val, _ := a4[13].(string)
	val = strings.TrimSpace(val)
	if val == "" {
		return "", errors.New("failed to resolve visitorData")
	}

	return val, nil
}

func fetchVideoMetaBrowserScrape(ctx context.Context, videoID string) (string, time.Duration, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://www.youtube.com/watch?v="+videoID, nil)
	// Headers help avoid consent/AB variants
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Cookie", "CONSENT=YES+cb.20210328-17-p0.en+FX+123;")
	resp, err := http.Get("https://www.youtube.com/watch?v=" + videoID)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", 0, err
	}

	sub := durationRegex.FindSubmatch(body)
	if sub == nil {
		return "", 0, errors.New("failed to parse video duration: regex match failed")
	}
	iso := string(sub[1])

	dur, err := parseISO8601(iso)
	if err != nil {
		return "", 0, errors.New("failed to parse video duration: invalid iso format")
	}

	parts := titleRegex.FindSubmatch(body)
	if parts == nil {
		return "", 0, errors.New("failed to parse video title: regex match failed")
	}
	title := string(parts[1])

	return title, dur, nil
}

func parseISO8601(s string) (time.Duration, error) {
	m := iso8601Regex.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("invalid ISO 8601 duration: %q", s)
	}
	var d time.Duration
	if h := m[1]; h != "" {
		hh, _ := strconv.Atoi(h)
		d += time.Duration(hh) * time.Hour
	}
	if m := m[2]; m != "" {
		mm, _ := strconv.Atoi(m)
		d += time.Duration(mm) * time.Minute
	}
	if s := m[3]; s != "" {
		ss, _ := strconv.Atoi(s)
		d += time.Duration(ss) * time.Second
	}
	return d, nil
}

func validateYTUrl(url string) (string, bool) {
	if url == "" {
		return "", false
	}
	sm := youtubeRegex.FindStringSubmatch(url)
	if len(sm) < 2 {
		return "", false
	}
	vid := sm[1]
	if vid == "" {
		return "", false
	}
	return vid, true
}

func (pr *playerResponse) IsAgeRestricted() bool {
	// Direct flag (when present)
	if pr.VideoDetails.AgeRestricted {
		return true
	}
	// Microformat rating
	if strings.EqualFold(pr.Microformat.PlayerMicroformatRenderer.YTRating, "ytAgeRestricted") {
		return true
	}
	// Family-safe + a reason/status that implies age gating
	ps := pr.PlayabilityStatus
	if !pr.Microformat.PlayerMicroformatRenderer.IsFamilySafe &&
		(ps.Status == "AGE_VERIFICATION_REQUIRED" ||
			strings.Contains(strings.ToLower(ps.Reason), "age") ||
			ps.DesktopLegacyAgeGateReason > 0) {
		return true
	}
	return false
}

func (r *ytDataAPIResp) AnyAgeRestricted() bool {
	for _, it := range r.Items {
		if strings.EqualFold(it.ContentDetails.ContentRating.YTRating, "ytAgeRestricted") {
			return true
		}
	}
	return false
}
