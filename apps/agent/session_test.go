package main

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// N cold requests are one login (one B1 licence slot), and a session B1 expired is one re-login,
// however many requests find out at once. The cookies come back whole: an Expires with a comma in
// it, and the load balancer's ROUTEID.
func TestOneLoginInFlight(t *testing.T) {
	var logins atomic.Int32
	var session atomic.Value
	session.Store("s1")
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/b1s/v2/Login":
			n := logins.Add(1)
			time.Sleep(50 * time.Millisecond)
			id := "s" + string(rune('0'+n))
			session.Store(id)
			http.SetCookie(w, &http.Cookie{Name: "B1SESSION", Value: id, Path: "/b1s/v2", Expires: time.Date(2100, 6, 9, 10, 18, 14, 0, time.UTC)})
			http.SetCookie(w, &http.Cookie{Name: "ROUTEID", Value: ".node1", Path: "/"})
			w.Write([]byte(`{"SessionId":"` + id + `"}`))
		case "/b1s/v2/Items":
			c, err := r.Cookie("B1SESSION")
			route, _ := r.Cookie("ROUTEID")
			if err != nil || c.Value != session.Load() || route == nil {
				w.WriteHeader(401)
				w.Write([]byte(`{"error":{"code":301,"message":"Invalid session"}}`))
				return
			}
			w.Write([]byte(`{"value":[]}`))
		}
	}))
	defer srv.Close()

	base, _ := url.Parse(srv.URL + "/b1s/v2/")
	s := newSession("b1", base, "Login", "Logout", "session", "SBODEMO", "manager", "x", log.New(io.Discard, "", 0))
	items := base.ResolveReference(&url.URL{Path: "Items"})
	burst := func() {
		var wg sync.WaitGroup
		for range 20 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r, err := s.Do("GET", items, nil, nil)
				if err != nil || r.Status != 200 {
					t.Errorf("request failed: %v %v", r, err)
				}
			}()
		}
		wg.Wait()
	}

	burst()
	if n := logins.Load(); n != 1 {
		t.Fatalf("20 cold requests logged in %d times, want 1", n)
	}
	session.Store("expired") // B1 dropped the session
	burst()
	if n := logins.Load(); n != 2 {
		t.Fatalf("an expiry cost %d logins in total, want 2", n)
	}
}

func TestParseSAPError(t *testing.T) {
	for _, c := range []struct {
		body string
		code any
		msg  string
	}{
		{`{"error":{"code":-2028,"message":{"lang":"en-us","value":"No matching records found"}}}`, float64(-2028), "No matching records found"},
		{`{"error":{"code":"301","message":"Invalid session"}}`, "301", "Invalid session"},
		{`{"odata":"x"}`, nil, "SAP returned 500 with no message."},
		{`Bad Gateway`, nil, "Bad Gateway"},
	} {
		e := parseSAPError(500, []byte(c.body))
		if e.Code != c.code || e.Message != c.msg {
			t.Errorf("%s: got %v %q", c.body, e.Code, e.Message)
		}
	}
}
