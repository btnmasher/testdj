package shared

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

var cfConnectingIP = http.CanonicalHeaderKey("Cf-Connecting-IP")
var trueClientIP = http.CanonicalHeaderKey("True-Client-IP")
var xForwardedFor = http.CanonicalHeaderKey("X-Forwarded-For")
var xRealIP = http.CanonicalHeaderKey("X-Real-IP")

func RealIP(h http.Handler) http.Handler {
	fn := func(w http.ResponseWriter, r *http.Request) {
		if rip := realIP(r); rip != "" {
			r.RemoteAddr = rip
		}
		h.ServeHTTP(w, r)
	}

	return http.HandlerFunc(fn)
}

func realIP(r *http.Request) string {
	var ip string

	if cfip := r.Header.Get(cfConnectingIP); cfip != "" {
		ip = cfip
	} else if tcip := r.Header.Get(trueClientIP); tcip != "" {
		ip = tcip
	} else if xrip := r.Header.Get(xRealIP); xrip != "" {
		ip = xrip
	} else if xff := r.Header.Get(xForwardedFor); xff != "" {
		ip, _, _ = strings.Cut(xff, ",")
	}
	if ip == "" || net.ParseIP(ip) == nil {
		return ""
	}
	return ip
}

func ParseHost(host string) (string, error) {
	ip, _, err := net.SplitHostPort(host)
	if err != nil {
		parsed := net.ParseIP(host)
		if parsed == nil {
			return "", fmt.Errorf("invalid host: %s - %s", host, err.Error())
		}
		ip = parsed.String()
	}
	return ip, nil
}
