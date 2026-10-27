package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
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

// Beas signs in with { User, Pwd } and wants its beas-sessionid back as a bearer token; an expired
// one is one re-login, and a wrong password is Beas' own sentence.
func TestBeasBearer(t *testing.T) {
	var logins atomic.Int32
	var session atomic.Value
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/beas/Login":
			var b struct{ User, Pwd string }
			json.NewDecoder(r.Body).Decode(&b)
			if b.User != "x" || b.Pwd != "1234" {
				w.WriteHeader(401)
				w.Write([]byte(`{"error":{"code":401,"message":{"lang":"en-us","value":"Login Fail: Wrong user, wrong password, wrong station passord"}}}`))
				return
			}
			id := fmt.Sprint("10261439136026240", logins.Add(1))
			session.Store(id)
			w.Write([]byte(`{"ret_code":0,"ret_text":"login ok","beas-sessionid":"` + id + `"}`))
		case "/beas/Items":
			if r.Header.Get("Authorization") != "Bearer "+session.Load().(string) {
				w.WriteHeader(401)
				return
			}
			w.Write([]byte(`{"value":[]}`))
		}
	}))
	defer srv.Close()
	base, _ := url.Parse(srv.URL + "/beas/")
	items := base.ResolveReference(&url.URL{Path: "Items"})
	quiet := log.New(io.Discard, "", 0)

	// The UI's sentence, plus the login call and Beas' whole answer for Confire's server log.
	_, err := newSession("Beas", base, "Login", "Logout", "bearer", "", "x", "nope", quiet).Do("GET", items, nil, nil)
	if e, _ := err.(*SAPError); e == nil || e.Message != "Login Fail: Wrong user, wrong password, wrong station passord" ||
		e.Call != "POST "+srv.URL+"/beas/Login" || !strings.Contains(e.Body, `"lang":"en-us"`) {
		t.Fatalf("wrong password: %#v", err)
	}
	s := newSession("Beas", base, "Login", "Logout", "bearer", "", "x", "1234", quiet)
	for range 2 {
		if r, err := s.Do("GET", items, nil, nil); err != nil || r.Status != 200 {
			t.Fatalf("request failed: %v %v", r, err)
		}
		session.Store("expired") // Beas dropped the session
	}
	if n := logins.Load(); n != 2 {
		t.Fatalf("a login and an expiry cost %d logins, want 2", n)
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
