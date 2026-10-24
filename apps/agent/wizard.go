package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"
)

// The setup wizard (spec 2026-10-21 §3): the SAP questions, each section tested with a real login
// before it is kept; the pairing code last, so a long SAP section cannot eat its hour; then the
// service and the tunnel. Run again on an installed box, it changes what is there instead.

type wizard struct {
	in     *bufio.Reader
	out    io.Writer
	server string
	path   string
}

// printable is what Confire may print (entity-profiles.ts PRINTABLE), in the order asked.
var printable = []string{"Quotations", "Orders", "DeliveryNotes", "Invoices"}

func newWizard(path, server string) *wizard {
	initConsole()
	return &wizard{in: bufio.NewReader(os.Stdin), out: os.Stdout, server: server, path: path}
}

func setup(path, server string) error {
	if relaunched, err := ensureAdmin(); err != nil || relaunched {
		return err
	}
	w := newWizard(path, server)
	fmt.Fprintf(w.out, "Confire agent setup (%s)\n\n", version)
	if cfg, err := loadConfig(path); err == nil && isInstalled(path) {
		return w.modify(cfg)
	}
	cfg := &Config{}
	w.b1(cfg, true)
	if w.yes("Beas — configure?", false) {
		cfg.Beas = w.beas(cfg)
	}
	if w.yes("Printing (SAP API Gateway) — configure?", false) {
		cfg.Print = w.print(cfg)
	}
	cfg.Port = agentPort()
	w.pair(cfg)
	return w.finish(cfg)
}

func uninstallCommand(path string) error {
	if relaunched, err := ensureAdmin(); err != nil || relaunched {
		return err
	}
	return newWizard(path, "").uninstall()
}

// ---- Prompts -----------------------------------------------------------------------------------

func (w *wizard) line() string {
	s, err := w.in.ReadString('\n')
	if err != nil && s == "" {
		fmt.Fprintln(os.Stderr, "\nSetup needs answers, and its input closed.")
		os.Exit(1)
	}
	return strings.TrimRight(s, "\r\n")
}

func (w *wizard) ask(label, def string) string {
	if def != "" {
		fmt.Fprintf(w.out, "  %s [%s]: ", label, def)
	} else {
		fmt.Fprintf(w.out, "  %s: ", label)
	}
	if v := strings.TrimSpace(w.line()); v != "" {
		return v
	}
	return def
}

func (w *wizard) must(label, def string) string {
	for {
		if v := w.ask(label, def); v != "" {
			return v
		}
	}
}

func (w *wizard) choice(label, def string, options ...string) string {
	for {
		v := strings.ToLower(w.ask(label, def))
		for _, o := range options {
			if v == o {
				return o
			}
		}
	}
}

func (w *wizard) yes(question string, def bool) bool {
	hint := "y/N"
	if def {
		hint = "Y/n"
	}
	fmt.Fprintf(w.out, "%s [%s]: ", question, hint)
	switch strings.ToLower(strings.TrimSpace(w.line())) {
	case "y", "yes", "s", "si", "sí":
		return true
	case "n", "no":
		return false
	}
	return def
}

// password reads without echo on a console. Blank keeps `current`, else takes `fallback` (the B1
// password, offered as "same as SAP B1").
func (w *wizard) password(label, current, fallback string) string {
	hint := ""
	switch {
	case current != "":
		hint = " [unchanged]"
	case fallback != "":
		hint = " [same as SAP B1]"
	}
	fmt.Fprintf(w.out, "  %s%s: ", label, hint)
	var v string
	if fd := int(os.Stdin.Fd()); term.IsTerminal(fd) {
		b, _ := term.ReadPassword(fd)
		fmt.Fprintln(w.out)
		v = string(b)
	} else {
		v = w.line()
	}
	switch {
	case v != "":
		return v
	case current != "":
		return current
	}
	return fallback
}

func (w *wizard) test(ok string, fn func() error) bool {
	fmt.Fprint(w.out, "  Testing… ")
	if err := fn(); err != nil {
		fmt.Fprintf(w.out, "✗ %v\n\n", err)
		return false
	}
	fmt.Fprintf(w.out, "✓ %s\n\n", ok)
	return true
}

func or(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// ---- Sections ----------------------------------------------------------------------------------

// testLogin signs in to a service the way the agent will, then gives the licence slot back. A
// basic-auth service has no login, so it is one read of its root instead.
func testLogin(name string, svc Service, defaultPath, loginPath, logoutPath, company string) error {
	base, err := svc.base(defaultPath)
	if err != nil {
		return err
	}
	s := newSession(name, base, loginPath, logoutPath, svc.Auth, company, svc.User, svc.Pass, discard)
	if svc.Auth == "basic" {
		r, err := s.Do("GET", base, map[string]string{"Accept": "application/json"}, nil)
		if err == nil && r.Status >= 300 {
			err = parseSAPError(r.Status, r.Body)
		}
		return err
	}
	if _, _, err := s.ensure(); err != nil {
		return err
	}
	s.Logout()
	return nil
}

func testB1(cfg *Config) error {
	return testLogin("SAP B1", cfg.B1, b1BasePath, "Login", "Logout", cfg.CompanyDb)
}
func testBeas(cfg *Config) error {
	return testLogin("Beas", *cfg.Beas, "/", "Login", "Logout", cfg.CompanyDb)
}
func testPrint(cfg *Config) error {
	return testLogin("API Gateway", Service{URL: cfg.Print.URL, User: cfg.Print.User, Pass: cfg.Print.Pass}, "/", "login", "", cfg.CompanyDb)
}

// b1 asks SAP B1's section until a login works. The company is asked here only on a first install:
// afterwards it changes through Change company, which re-tests everything.
func (w *wizard) b1(cfg *Config, askCompany bool) {
	fmt.Fprintln(w.out, "SAP B1 Service Layer")
	next := *cfg
	for {
		next.B1.URL = w.must("URL", or(next.B1.URL, "https://localhost:50000"))
		if askCompany {
			next.CompanyDb = w.must("Company database", next.CompanyDb)
		}
		next.B1.User = w.must("User", or(next.B1.User, "manager"))
		next.B1.Pass = w.password("Password", next.B1.Pass, "")
		if w.test("logged in to "+next.CompanyDb, func() error { return testB1(&next) }) {
			cfg.B1, cfg.CompanyDb = next.B1, next.CompanyDb
			return
		}
	}
}

func (w *wizard) beas(cfg *Config) *Service {
	fmt.Fprintln(w.out, "Beas")
	next := *cfg
	if next.Beas == nil {
		next.Beas = &Service{Auth: "session"}
	} else {
		b := *next.Beas
		next.Beas = &b
	}
	s := next.Beas
	for {
		s.URL = w.must("URL, with its path", s.URL)
		s.Auth = w.choice("Sign-in, session or basic", or(s.Auth, "session"), "session", "basic")
		s.User = w.must("User", or(s.User, cfg.B1.User))
		s.Pass = w.password("Password", s.Pass, cfg.B1.Pass)
		if w.test("signed in", func() error { return testBeas(&next) }) {
			return s
		}
	}
}

func (w *wizard) print(cfg *Config) *Print {
	fmt.Fprintln(w.out, "Printing (SAP API Gateway)")
	next := *cfg
	p := &Print{Layouts: map[string]string{}}
	if cfg.Print != nil {
		*p = *cfg.Print
		p.Layouts = maps.Clone(cfg.Print.Layouts)
		if p.Layouts == nil {
			p.Layouts = map[string]string{}
		}
	}
	next.Print = p
	host := "localhost"
	if u, err := url.Parse(cfg.B1.URL); err == nil && u.Hostname() != "" {
		host = u.Hostname()
	}
	for {
		p.URL = w.must("URL", or(p.URL, "https://"+host+":60020"))
		p.User = w.must("User", or(p.User, cfg.B1.User))
		p.Pass = w.password("Password", p.Pass, cfg.B1.Pass)
		for _, e := range printable {
			label := "Layout for " + e + " (blank = not printable)"
			if p.Layouts[e] != "" {
				label = "Layout for " + e + " (- = not printable)"
			}
			if v := w.ask(label, p.Layouts[e]); v == "" || v == "-" {
				delete(p.Layouts, e)
			} else {
				p.Layouts[e] = v
			}
		}
		if w.test("signed in", func() error { return testPrint(&next) }) {
			return p
		}
	}
}

// ---- Pairing -----------------------------------------------------------------------------------

type pairResult struct {
	Slug        string `json:"slug"`
	AgentURL    string `json:"agentUrl"`
	Secret      string `json:"secret"`
	TunnelToken string `json:"tunnelToken"`
}

// redeem trades the code for the agent's secret and tunnel token. The company's name goes along so
// Confire knows which company it reaches; no credential does.
func redeem(server, code string, cfg *Config) (*pairResult, error) {
	body, _ := json.Marshal(map[string]any{"code": code, "port": cfg.Port, "version": version, "companyDb": cfg.CompanyDb})
	c := &http.Client{Timeout: 2 * time.Minute} // the server creates the tunnel meanwhile
	res, err := c.Post(server+"/api/agent/pair", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("cannot reach %s: %v", server, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode != http.StatusOK {
		var m struct{ Message string }
		if json.Unmarshal(raw, &m) != nil || m.Message == "" {
			m.Message = fmt.Sprintf("%s answered %d", server, res.StatusCode)
		}
		return nil, errors.New(m.Message)
	}
	var p pairResult
	if json.Unmarshal(raw, &p) != nil || p.Secret == "" {
		return nil, fmt.Errorf("%s gave an answer this agent does not understand", server)
	}
	return &p, nil
}

func (w *wizard) pair(cfg *Config) {
	for {
		fmt.Fprint(w.out, "Pairing code from Confire: ")
		code := strings.TrimSpace(w.line())
		if code == "" {
			continue
		}
		res, err := redeem(w.server, code, cfg)
		if err != nil {
			fmt.Fprintf(w.out, "  ✗ %v\n", err)
			continue
		}
		cfg.Secret, cfg.TunnelToken = res.Secret, res.TunnelToken
		fmt.Fprintf(w.out, "  ✓ paired with workspace %q\n\n", res.Slug)
		return
	}
}

// ---- Install and change ------------------------------------------------------------------------

// finish saves the config and installs (or updates) the service onto it.
func (w *wizard) finish(cfg *Config) error {
	if err := saveConfig(w.path, cfg); err != nil {
		return err
	}
	if !canInstall {
		fmt.Fprintf(w.out, "Saved %s. Nothing to install on this system; start the agent with\n  go run . run --config %s\n", w.path, w.path)
		return nil
	}
	fmt.Fprint(w.out, "Installing service… ")
	if err := install(); err != nil {
		return err
	}
	fmt.Fprint(w.out, "✓   ")
	w.waitConnected(cfg)
	return nil
}

// apply saves a change and restarts the service onto it.
func (w *wizard) apply(cfg *Config) error {
	if err := saveConfig(w.path, cfg); err != nil {
		return err
	}
	if !canInstall {
		fmt.Fprintf(w.out, "Saved %s. Restart `run` to apply it.\n", w.path)
		return nil
	}
	fmt.Fprint(w.out, "Restarting service… ")
	if err := restart(); err != nil {
		return err
	}
	fmt.Fprint(w.out, "✓   ")
	w.waitConnected(cfg)
	return nil
}

// waitConnected watches the service's own /health until cloudflared reports the tunnel ready.
func (w *wizard) waitConnected(cfg *Config) {
	fmt.Fprint(w.out, "Tunnel… ")
	for deadline := time.Now().Add(90 * time.Second); time.Now().Before(deadline); time.Sleep(time.Second) {
		res, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port))
		if err != nil {
			continue
		}
		var h struct{ Tunnel *bool }
		json.NewDecoder(res.Body).Decode(&h)
		res.Body.Close()
		if h.Tunnel != nil && *h.Tunnel {
			fmt.Fprintln(w.out, "✓ connected")
			fmt.Fprintln(w.out, "Done. Confire now shows this server as connected. You can close this window.")
			return
		}
	}
	fmt.Fprintf(w.out, "✗ not connected yet. The service keeps trying; its log is in %s\n", logDir())
}

func (w *wizard) modify(cfg *Config) error {
	fmt.Fprintf(w.out, "This server is paired with Confire, company %s.\n\n", cfg.CompanyDb)
	type option struct {
		label string
		run   func() error
	}
	opts := []option{
		{"Change company", func() error { return w.changeCompany(cfg) }},
		{"Change SAP B1 credentials", func() error { w.b1(cfg, false); return w.apply(cfg) }},
		{"Change Beas", func() error {
			if cfg.Beas != nil && !w.yes("Keep Beas?", true) {
				cfg.Beas = nil
			} else {
				cfg.Beas = w.beas(cfg)
			}
			return w.apply(cfg)
		}},
		{"Change printing", func() error {
			if cfg.Print != nil && !w.yes("Keep printing?", true) {
				cfg.Print = nil
			} else {
				cfg.Print = w.print(cfg)
			}
			return w.apply(cfg)
		}},
		{"Pair again (a new code from Confire)", func() error { w.pair(cfg); return w.apply(cfg) }},
	}
	if installed := installedVersion(); isNewer(version, installed) {
		opts = append(opts, option{fmt.Sprintf("Update the agent from %s to %s", installed, version), func() error { return w.finish(cfg) }})
	}
	opts = append(opts, option{"Uninstall", w.uninstall})
	for i, o := range opts {
		fmt.Fprintf(w.out, "  %d) %s\n", i+1, o.label)
	}
	fmt.Fprintln(w.out, "  0) Exit")
	for {
		n, err := strconv.Atoi(w.ask("Choice", "0"))
		if err == nil && n == 0 {
			return nil
		}
		if err == nil && n >= 1 && n <= len(opts) {
			fmt.Fprintln(w.out)
			return opts[n-1].run()
		}
	}
}

// changeCompany moves every service to another company: each is re-tested there, and only one whose
// credentials fail is asked again. Confire follows by itself on its next call (spec §6.2).
func (w *wizard) changeCompany(cfg *Config) error {
	fmt.Fprintln(w.out, "Portal clients will see the documents of their CardCode in the new company.")
	cfg.CompanyDb = w.must("New company database", "")
	fmt.Fprintln(w.out)
	if !w.test("SAP B1 logged in to "+cfg.CompanyDb, func() error { return testB1(cfg) }) {
		w.b1(cfg, false)
	}
	if cfg.Beas != nil && !w.test("Beas signed in", func() error { return testBeas(cfg) }) {
		cfg.Beas = w.beas(cfg)
	}
	if cfg.Print != nil && !w.test("API Gateway signed in", func() error { return testPrint(cfg) }) {
		cfg.Print = w.print(cfg)
	}
	return w.apply(cfg)
}

func (w *wizard) uninstall() error {
	if !w.yes("Remove the Confire agent, its service and its settings from this server?", false) {
		return nil
	}
	if err := uninstallAll(w.path); err != nil {
		return err
	}
	fmt.Fprintln(w.out, "Removed. To connect SAP again, download the agent from Confire and pair it.")
	return nil
}
