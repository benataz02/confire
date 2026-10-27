package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// The wire (spec 2026-10-21 §6.1):
//
//	GET  /health                 no auth   { ok, version, companyDb, services: { b1, beas, print }, tunnel?, error? }
//	POST /{b1|beas}/request      Bearer    { method, path, headers?, body? } → { status, data }
//	POST /print                  Bearer    { entity, docEntry } → { pdf, fileName }
//
// Errors are { error: { status, code, message } }. Every Bearer call carries X-Confire-Company: a
// call built for another company than agent.json's is refused with 409 COMPANY_CHANGED before it
// touches SAP, so nothing in flight during a switch can land in the new company.

type Agent struct {
	cfg        *Config
	secretHash [32]byte
	b1, beas   *Session // beas nil = not configured
	gateway    *Gateway // nil = printing not configured
	tunnel     *atomic.Bool
	log        *log.Logger
}

func newAgent(cfg *Config, lg *log.Logger) (*Agent, error) {
	b1Base, err := cfg.B1.base(b1BasePath)
	if err != nil {
		return nil, fmt.Errorf("b1: %w", err)
	}
	a := &Agent{
		cfg: cfg, secretHash: sha256.Sum256([]byte(cfg.Secret)), log: lg,
		b1: newSession("b1", b1Base, "Login", "Logout", cfg.B1.Auth, cfg.CompanyDb, cfg.B1.User, cfg.B1.Pass, lg),
	}
	if cfg.Beas != nil {
		base, err := cfg.Beas.base("/")
		if err != nil {
			return nil, fmt.Errorf("beas: %w", err)
		}
		a.beas = newSession("beas", base, "Login", "Logout", cfg.Beas.Auth, cfg.CompanyDb, cfg.Beas.User, cfg.Beas.Pass, lg)
	}
	if cfg.Print != nil {
		base, err := Service{URL: cfg.Print.URL}.base("/")
		if err != nil {
			return nil, fmt.Errorf("print: %w", err)
		}
		a.gateway = &Gateway{newSession("print", base, "login", "", "session", cfg.CompanyDb, cfg.Print.User, cfg.Print.Pass, lg), cfg.Print.Layouts}
	}
	return a, nil
}

func (a *Agent) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.health)
	mux.Handle("POST /b1/request", a.guard(a.request(a.b1, "SAP B1")))
	mux.Handle("POST /beas/request", a.guard(a.request(a.beas, "Beas")))
	mux.Handle("POST /print", a.guard(http.HandlerFunc(a.print)))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusNotFound, &SAPError{Status: 404, Message: fmt.Sprintf("Unknown route %s %s", r.Method, r.URL.Path)})
	})
	return mux
}

// fail writes the error envelope.
func fail(w http.ResponseWriter, httpStatus int, e *SAPError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(httpStatus)
	json.NewEncoder(w).Encode(map[string]any{"error": e})
}

// sapFail relays a SAP-side failure: the real status is in the envelope; the HTTP status says only
// "the agent is fine, SAP is not", so an agent-auth 401 is never confused with a SAP 401. Not 502:
// Cloudflare's edge swaps an origin's 502/504 for its own HTML page, and the envelope is lost.
func sapFail(w http.ResponseWriter, err error) {
	var e *SAPError
	if !errors.As(err, &e) {
		e = &SAPError{Status: 502, Message: err.Error()}
	}
	fail(w, http.StatusFailedDependency, e)
}

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func (a *Agent) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hashed compare, so the lengths always match and the comparison stays constant-time.
		token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if sum := sha256.Sum256([]byte(token)); subtle.ConstantTimeCompare(sum[:], a.secretHash[:]) != 1 {
			fail(w, http.StatusUnauthorized, &SAPError{Status: 401, Message: "Bad agent secret"})
			return
		}
		if company := r.Header.Get("X-Confire-Company"); company != a.cfg.CompanyDb {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
				"status": 409, "code": "COMPANY_CHANGED", "companyDb": a.cfg.CompanyDb,
				"message": fmt.Sprintf("This agent serves company %s, not %q.", a.cfg.CompanyDb, company),
			}})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
		next.ServeHTTP(w, r)
	})
}

func (a *Agent) health(w http.ResponseWriter, _ *http.Request) {
	print := []string{}
	if a.gateway != nil {
		print = a.gateway.Printable()
	}
	out := map[string]any{
		"ok": a.b1.LastError() == nil, "version": version, "companyDb": a.cfg.CompanyDb,
		"services": map[string]any{"b1": true, "beas": a.beas != nil, "print": print},
	}
	if err := a.b1.LastError(); err != nil {
		out["error"] = err.Error()
	}
	if a.tunnel != nil {
		out["tunnel"] = a.tunnel.Load()
	}
	reply(w, out)
}

func (a *Agent) request(s *Session, what string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s == nil {
			fail(w, http.StatusServiceUnavailable, &SAPError{Status: 503, Message: what + " is not configured on the SAP server's agent. Add it in the agent's setup."})
			return
		}
		var in struct {
			Method  string            `json:"method"`
			Path    string            `json:"path"`
			Headers map[string]string `json:"headers"`
			Body    json.RawMessage   `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			fail(w, http.StatusBadRequest, &SAPError{Status: 400, Message: "Not a request: " + err.Error()})
			return
		}
		ok, err := allow(s.Base, in.Method, in.Path, in.Headers)
		if err != nil {
			a.log.Printf("%s: %v", s.Name, err)
			fail(w, http.StatusForbidden, err.(*SAPError))
			return
		}
		headers := ok.Headers
		headers["Accept"] = "application/json"
		if strings.HasPrefix(ok.Rel, "$metadata") {
			headers["Accept"] = "application/xml"
		}
		var body []byte
		if len(in.Body) > 0 && string(in.Body) != "null" {
			body = in.Body
			headers["Content-Type"] = "application/json"
		}
		res, err := s.Do(in.Method, ok.URL, headers, body)
		if err != nil {
			sapFail(w, err)
			return
		}
		if res.Status >= 300 {
			e := parseSAPError(res.Status, res.Body)
			e.Call = in.Method + " " + ok.URL.Redacted()
			sapFail(w, e)
			return
		}
		// data: the parsed JSON, or the text of a non-JSON answer ($metadata's EDMX), or null.
		data := json.RawMessage("null")
		switch {
		case len(res.Body) == 0:
		case !strings.Contains(res.ContentType, "xml") && json.Valid(res.Body):
			data = res.Body
		default:
			data, _ = json.Marshal(string(res.Body))
		}
		reply(w, map[string]any{"status": res.Status, "data": data, "call": in.Method + " " + ok.URL.Redacted()})
	}
}

func (a *Agent) print(w http.ResponseWriter, r *http.Request) {
	if a.gateway == nil {
		fail(w, http.StatusServiceUnavailable, &SAPError{Status: 503, Message: "Printing is not configured on the SAP server's agent. Add it in the agent's setup."})
		return
	}
	var in struct {
		Entity   string  `json:"entity"`
		DocEntry float64 `json:"docEntry"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.DocEntry < 1 || in.DocEntry != float64(int64(in.DocEntry)) {
		fail(w, http.StatusBadRequest, &SAPError{Status: 400, Message: "Not a document key"})
		return
	}
	pdf, name, err := a.gateway.Export(in.Entity, int64(in.DocEntry))
	if err != nil {
		sapFail(w, err)
		return
	}
	reply(w, map[string]string{"pdf": pdf, "fileName": name})
}

func (a *Agent) logout() {
	for _, s := range []*Session{a.b1, a.beas} {
		if s != nil {
			s.Logout()
		}
	}
	if a.gateway != nil {
		a.gateway.s.Logout()
	}
}

// serve runs the agent until ctx ends: on 127.0.0.1 only, since cloudflared runs on the same machine
// and nothing on the LAN has any business with it. A failed B1 login at start is logged and
// reported by /health; the agent keeps running so a fixed agent.json only needs a restart.
func serve(ctx context.Context, cfg *Config, lg *log.Logger, tunnel func(context.Context, *atomic.Bool)) error {
	a, err := newAgent(cfg, lg)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr: fmt.Sprintf("127.0.0.1:%d", cfg.Port), Handler: a.routes(),
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute, ErrorLog: lg,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	go func() {
		if _, _, err := a.b1.ensure(); err != nil {
			lg.Printf("SAP B1 login failed at start: %v", err)
		}
	}()
	if tunnel != nil {
		a.tunnel = new(atomic.Bool)
		go tunnel(ctx, a.tunnel)
	}
	lg.Printf("confire-agent %s on %s, company %s, beas %t, print %v", version, srv.Addr, cfg.CompanyDb, a.beas != nil, a.gateway != nil)
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shut)
	a.logout()
	return nil
}
