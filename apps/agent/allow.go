package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// The allowlist: what /request forwards, equal to what the Bun agent's named operations permitted —
// so a leaked agent secret still cannot issue arbitrary Service Layer calls. The cloud builds every
// path (packages/b1/src/query.ts); this decides which of them reach SAP.
//   - the path resolves under the service's base or is refused: a B1 nextLink, relative or
//     absolute, passes; another host, `..`, `//host` do not. Login/Logout are refused — the agent
//     owns the session.
//   - GET: any path. POST: one segment (`Quotations`, `SeriesService_GetDocumentSeries`), or
//     `<Set>(<key>)/<Action>` for an allowlisted action. PATCH, DELETE: `<Set>(<key>)`. No query
//     string on a write.
//   - headers: Prefer, If-Match, B1S-ReplaceCollectionsOnPatch, nothing else. Accept and
//     Content-Type are the agent's own.
// ponytail: parity with the Bun agent. Writes could be narrowed to the sets the cloud actually
// writes (entity-profiles.ts, the doc-copy targets, the service calls) once that list is stable.

// passHeaders, by lowercase name, in the spelling they are sent with.
var passHeaders = map[string]string{
	"prefer":                        "Prefer",
	"if-match":                      "If-Match",
	"b1s-replacecollectionsonpatch": "B1S-ReplaceCollectionsOnPatch",
}

// actions are the bound actions the cloud may ask for, per entity set (checked in the cloud's
// router too): a leaked secret must not be able to Cancel or Close anything else.
var actions = map[string][]string{"Quotations": {"Close"}}

const (
	ident  = `[A-Za-z_][A-Za-z0-9_]*`
	numLit = `-?[0-9]+(?:\.[0-9]+)?`
	strLit = `'(?:[^']|'')*'`
	lit    = `(?:` + numLit + `|` + strLit + `)`
)

var (
	single = regexp.MustCompile(`^` + ident + `$`)
	// The key is checked as a whole OData literal (buildKeyValue's output), so `Items('x')/Nav('y')`
	// cannot pose as a key.
	entityRe = regexp.MustCompile(`^(` + ident + `)\((.*)\)(?:/(` + ident + `))?$`)
	keyRe    = regexp.MustCompile(`^(?:` + lit + `|` + ident + `=` + lit + `(?:,` + ident + `=` + lit + `)*)$`)
)

// Allowed is a request the agent may send: where, the headers to pass on, and the path under the base.
type Allowed struct {
	URL     *url.URL
	Headers map[string]string
	Rel     string
}

// refuse is the agent's own 403, coded so Confire never words it as SAP's rejection.
func refuse(f string, a ...any) error {
	return &SAPError{Status: 403, Code: "AGENT_REFUSED", Message: "Refused by the agent: " + fmt.Sprintf(f, a...)}
}

func allow(base *url.URL, method, path string, headers map[string]string) (*Allowed, error) {
	pass := map[string]string{}
	for k, v := range headers {
		name, ok := passHeaders[strings.ToLower(k)]
		if !ok {
			return nil, refuse("header %q", k)
		}
		pass[name] = v
	}

	ref, err := url.Parse(encodeRaw(path))
	if err != nil {
		return nil, refuse("path %q: %v", path, err)
	}
	u := base.ResolveReference(ref)
	u.Fragment, u.RawFragment = "", ""
	if u.Scheme != base.Scheme || !strings.EqualFold(u.Host, base.Host) || u.User != nil || !strings.HasPrefix(u.Path, base.Path) {
		return nil, refuse("%q is outside %s", path, base)
	}
	// ResolveReference removed literal dot segments; an encoded one (%2e%2e) survives decoded.
	for _, seg := range strings.Split(u.Path, "/") {
		if seg == "." || seg == ".." {
			return nil, refuse("%q", path)
		}
	}
	rel := strings.TrimPrefix(u.Path, base.Path)
	if head := strings.ToLower(strings.SplitN(strings.SplitN(rel, "/", 2)[0], "(", 2)[0]); head == "login" || head == "logout" {
		return nil, refuse("the agent owns the session")
	}

	ok := false
	switch method {
	case "GET":
		ok = true
	case "POST", "PATCH", "DELETE":
		if u.RawQuery != "" || u.ForceQuery {
			return nil, refuse("a query string on %s", method)
		}
		if method == "POST" && single.MatchString(rel) {
			ok = true
			break
		}
		m := entityRe.FindStringSubmatch(rel)
		if m == nil || !keyRe.MatchString(m[2]) {
			break
		}
		if method == "POST" {
			for _, a := range actions[m[1]] {
				ok = ok || m[3] == a
			}
		} else {
			ok = m[3] == ""
		}
	}
	if !ok {
		return nil, refuse("%s %s", method, rel)
	}
	return &Allowed{URL: u, Headers: pass, Rel: rel}, nil
}

// encodeRaw percent-encodes what may not appear raw in a URL — space, quotes, braces, non-ASCII,
// a % that starts no escape — the way a browser's fetch did for the Bun agent. Everything else
// (the `'()` of a key, `$`, `,`, `=`) stays as query.ts wrote it: B1 reads `$expand` unencoded.
func encodeRaw(s string) string {
	const hex = "0123456789ABCDEF"
	isHex := func(c byte) bool { return '0' <= c && c <= '9' || 'a' <= c|0x20 && c|0x20 <= 'f' }
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		escaped := c == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2])
		if c <= ' ' || c >= 0x7f || strings.IndexByte("\"<>\\^`{|}", c) >= 0 || (c == '%' && !escaped) {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}
