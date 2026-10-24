package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"time"
)

// SAPError is a failure as the cloud's B1Error reads it: { status, code, message }, B1's own error
// code kept intact so Confire maps status/code instead of regexing a sentence.
type SAPError struct {
	Status  int    `json:"status"`
	Code    any    `json:"code"`
	Message string `json:"message"`
}

func (e *SAPError) Error() string { return e.Message }

// parseSAPError is B1Error.parse: B1 answers { error: { code, message: { value } } } (v2) or
// { error: { code, message } }. The message is B1's own sentence and nothing else — it is what the
// UI shows; a JSON blob without one becomes a status, never the blob.
func parseSAPError(status int, payload []byte) *SAPError {
	var body struct {
		Error struct {
			Code    any             `json:"code"`
			Message json.RawMessage `json:"message"`
		} `json:"error"`
	}
	msg := ""
	var code any
	if json.Unmarshal(payload, &body) == nil {
		var s string
		var v struct{ Value string }
		if json.Unmarshal(body.Error.Message, &s) == nil {
			msg = s
		} else if json.Unmarshal(body.Error.Message, &v) == nil {
			msg = v.Value
		}
		switch c := body.Error.Code.(type) {
		case string, float64:
			code = c
		}
	} else {
		msg = string(payload)
		if len(msg) > 500 {
			msg = msg[:500]
		}
	}
	if msg = strings.TrimSpace(msg); msg == "" {
		msg = fmt.Sprintf("SAP returned %d with no message.", status)
	}
	return &SAPError{Status: status, Code: code, Message: msg}
}

// Stock installs ship self-signed certificates on all three services, and the hop is the SAP
// server's own machine or LAN — so verification is off, and the wizard does not ask. No proxy: an
// environment proxy must never carry a SAP password off the LAN.
var sapTransport = &http.Transport{
	TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
	MaxIdleConnsPerHost: 16,
	IdleConnTimeout:     90 * time.Second,
}

// Session is one logged-in SAP service, ported from packages/b1's ServiceLayer (MIT sample) with
// its load-bearing fixes:
//   - every Set-Cookie kept whole (a cookie jar, not a split on ","): `Expires=Wed, 09 Jun …`
//     must not shred, and a load-balanced Service Layer needs ROUTEID back;
//   - one login in flight: N cold requests are one login and one licence slot, not N;
//   - a re-login once on 401, never twice for one expiry (the generation check);
//   - request timeouts, and a logout on stop that gives the slot back.
type Session struct {
	Name       string
	Base       *url.URL
	loginPath  string // "Login" (Service Layer) or "login" (API Gateway)
	logoutPath string // "" = no logout call
	basic      bool
	company    string
	user, pass string
	log        *log.Logger

	mu       sync.Mutex
	client   *http.Client // replaced by every login: a new jar is a new session
	gen      int
	ready    bool
	inflight *loginCall
	lastErr  error
}

type loginCall struct {
	done chan struct{}
	err  error
}

func newSession(name string, base *url.URL, loginPath, logoutPath, auth, company, user, pass string, lg *log.Logger) *Session {
	return &Session{
		Name: name, Base: base, loginPath: loginPath, logoutPath: logoutPath, basic: auth == "basic",
		company: company, user: user, pass: pass, log: lg,
	}
}

func newClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, Timeout: 60 * time.Second, Transport: sapTransport}
}

// ensure returns a logged-in client and its generation, logging in first when there is none. The
// login runs on its own goroutine, so one caller's cancelled request cannot fail everyone's.
func (s *Session) ensure() (*http.Client, int, error) {
	s.mu.Lock()
	if s.ready {
		defer s.mu.Unlock()
		return s.client, s.gen, nil
	}
	call := s.inflight
	if call == nil {
		call = &loginCall{done: make(chan struct{})}
		s.inflight = call
		go s.runLogin(call)
	}
	s.mu.Unlock()
	<-call.done
	if call.err != nil {
		return nil, 0, call.err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client, s.gen, nil
}

func (s *Session) runLogin(call *loginCall) {
	client, err := s.login()
	s.mu.Lock()
	if err == nil {
		s.client, s.ready = client, true
		s.gen++
	}
	s.inflight, s.lastErr, call.err = nil, err, err
	s.mu.Unlock()
	close(call.done)
}

// expire drops the session a 401 answered — unless a newer one already replaced it.
func (s *Session) expire(gen int) {
	s.mu.Lock()
	if s.gen == gen {
		s.ready = false
	}
	s.mu.Unlock()
}

func (s *Session) login() (*http.Client, error) {
	client := newClient()
	if s.basic {
		return client, nil
	}
	body, _ := json.Marshal(map[string]string{"CompanyDB": s.company, "UserName": s.user, "Password": s.pass})
	req, err := http.NewRequest("POST", s.Base.ResolveReference(&url.URL{Path: s.loginPath}).String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, &SAPError{Status: 503, Message: fmt.Sprintf("%s is unreachable at %s: %v", s.Name, s.Base, err)}
	}
	payload, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	res.Body.Close()
	if res.StatusCode >= 300 {
		e := parseSAPError(res.StatusCode, payload)
		s.log.Printf("%s login to %s failed (%d): %s", s.Name, s.company, e.Status, e.Message)
		return nil, e
	}
	// A Service Layer that answers with a SessionId but no cookie: the cookie it would have set.
	if len(client.Jar.Cookies(s.Base)) == 0 {
		var b struct{ SessionId string }
		if json.Unmarshal(payload, &b) != nil || b.SessionId == "" {
			return nil, &SAPError{Status: res.StatusCode, Message: s.Name + " login succeeded but returned neither cookies nor a SessionId"}
		}
		client.Jar.SetCookies(s.Base, []*http.Cookie{{Name: "B1SESSION", Value: b.SessionId}, {Name: "CompanyDB", Value: s.company}})
	}
	s.log.Printf("%s logged in to %s", s.Name, s.company)
	return client, nil
}

// Logout gives the licence slot back. Best effort: the service is stopping either way.
func (s *Session) Logout() {
	s.mu.Lock()
	client, ready := s.client, s.ready
	s.ready = false
	s.mu.Unlock()
	if !ready || s.basic || s.logoutPath == "" {
		return
	}
	req, _ := http.NewRequest("POST", s.Base.ResolveReference(&url.URL{Path: s.logoutPath}).String(), nil)
	c := *client
	c.Timeout = 10 * time.Second
	if res, err := c.Do(req); err == nil {
		res.Body.Close()
	}
}

// LastError is the last login's failure, nil after a good one.
func (s *Session) LastError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

type Reply struct {
	Status      int
	ContentType string
	Body        []byte
}

// Do sends one call in the session. A non-2xx answer is a Reply, for the caller to read; an error
// is a login that failed or a service that did not answer.
func (s *Session) Do(method string, u *url.URL, headers map[string]string, body []byte) (*Reply, error) {
	for attempt := 0; ; attempt++ {
		client, gen, err := s.ensure()
		if err != nil {
			return nil, err
		}
		var rd io.Reader
		if body != nil {
			rd = bytes.NewReader(body)
		}
		req, err := http.NewRequest(method, u.String(), rd)
		if err != nil {
			return nil, &SAPError{Status: 400, Message: err.Error()}
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		if s.basic {
			req.SetBasicAuth(s.user, s.pass)
		}
		started := time.Now()
		res, err := client.Do(req)
		if err != nil {
			return nil, &SAPError{Status: 503, Message: fmt.Sprintf("%s did not answer: %v", s.Name, err)}
		}
		payload, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
		res.Body.Close()
		if err != nil {
			return nil, &SAPError{Status: 502, Message: fmt.Sprintf("%s answer cut off: %v", s.Name, err)}
		}
		rel := strings.TrimPrefix(u.RequestURI(), s.Base.Path)
		if len(rel) > 300 {
			rel = rel[:300] + "…"
		}
		s.log.Printf("%s %s %d %dms %s", s.Name, method, res.StatusCode, time.Since(started).Milliseconds(), rel)
		// Reactive re-login, once: B1 idles a session out after ~30 min, and a keep-alive timer is
		// code that exists only to avoid one cheap retry.
		if (res.StatusCode == 401 || res.StatusCode == 403) && attempt == 0 && !s.basic {
			s.expire(gen)
			continue
		}
		return &Reply{Status: res.StatusCode, ContentType: res.Header.Get("Content-Type"), Body: payload}, nil
	}
}
