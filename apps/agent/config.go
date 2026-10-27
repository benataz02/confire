package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Config is agent.json: written by the wizard (by hand in dev), read once at start. A hand edit —
// another company, another password — takes effect on the next service restart. SAP credentials
// live here and nowhere else: pairing sends Confire the company's name, never a password.
// ponytail: plain JSON behind an Administrators/SYSTEM-only ACL; DPAPI if a customer asks.
type Config struct {
	Port        int    `json:"port"`
	Secret      string `json:"secret"`
	TunnelToken string `json:"tunnelToken,omitempty"`
	// CompanyDb is one field for all three services, so printing can never render a document of
	// another company than B1 reads.
	CompanyDb string   `json:"companyDb"`
	B1        Service  `json:"b1"`
	Beas      *Service `json:"beas,omitempty"`
	Print     *Print   `json:"print,omitempty"`
}

// Service is a Service Layer: B1's, or Beas'.
type Service struct {
	URL string `json:"url"`
	// BasePath under URL: B1's /b1s/v2/ when empty; the wizard writes Beas' whole URL instead.
	BasePath string `json:"basePath,omitempty"`
	// Auth is "session" (B1's POST Login, the default), "bearer" (Beas' POST Login, its session id
	// as a bearer token) or "basic" (an Authorization header per call).
	Auth string `json:"auth,omitempty"`
	User string `json:"user"`
	Pass string `json:"pass"`
}

// Print is the SAP B1 API Gateway's Reporting Service.
type Print struct {
	URL  string `json:"url"`
	User string `json:"user"`
	Pass string `json:"pass"`
	// Layouts maps an entity set to the Crystal layout DocCode that prints it; one without a layout
	// is not printable.
	Layouts map[string]string `json:"layouts"`
}

const b1BasePath = "/b1s/v2/"

func loadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if c.Port == 0 {
		c.Port = 4000
	}
	switch {
	case c.Secret == "":
		return nil, fmt.Errorf("%s: no \"secret\" — pair this agent first (confire-agent setup)", path)
	case c.CompanyDb == "":
		return nil, fmt.Errorf("%s: no \"companyDb\"", path)
	case c.B1.URL == "":
		return nil, fmt.Errorf("%s: no \"b1\".\"url\"", path)
	}
	return &c, nil
}

// saveConfig replaces the file in one rename, so a crash mid-write never leaves half a config.
func saveConfig(path string, c *Config) error {
	if err := prepareConfigDir(filepath.Dir(path)); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// base is the service's root URL, ending in "/": every request path resolves under it.
func (s Service) base(defaultPath string) (*url.URL, error) {
	p := s.BasePath
	if p == "" {
		p = defaultPath
	}
	raw := strings.TrimRight(s.URL, "/") + "/" + strings.Trim(p, "/")
	if !strings.HasSuffix(raw, "/") {
		raw += "/"
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("not an http(s) URL: %q", s.URL)
	}
	return u, nil
}
