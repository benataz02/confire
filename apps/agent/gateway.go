package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// Gateway prints through the SAP B1 API Gateway's Reporting Service: a different service from the
// Service Layer, on its own port with its own `POST /login`, and an export that answers with base64
// rather than a document. Rules kept from the Bun agent's api-gateway.ts: the session (Session
// above), `ExportPDFData?DocCode=<layout>`, `DocKey@` as the document key (Crystal's name for it,
// confirmed against a live gateway), and the three response shapes.
type Gateway struct {
	s       *Session
	layouts map[string]string
}

// Printable is the entity sets with a layout, sorted: what /health reports.
func (g *Gateway) Printable() []string {
	out := []string{}
	for k, v := range g.layouts {
		if v != "" {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func (g *Gateway) Export(entity string, docEntry int64) (pdf, fileName string, err error) {
	layout := g.layouts[entity]
	if layout == "" {
		return "", "", &SAPError{Status: 400, Message: fmt.Sprintf("No print layout for '%s' on the SAP server: add one in the agent's setup (Printing).", entity)}
	}
	u := g.s.Base.ResolveReference(&url.URL{Path: "rs/v1/ExportPDFData", RawQuery: "DocCode=" + url.QueryEscape(layout)})
	body, _ := json.Marshal([]map[string]any{{"name": "DocKey@", "type": "xsd:string", "value": [][]string{{strconv.FormatInt(docEntry, 10)}}}})
	r, err := g.s.Do("POST", u, map[string]string{"Content-Type": "application/json", "Accept": "application/json"}, body)
	if err != nil {
		return "", "", err
	}
	text := strings.TrimSpace(string(r.Body))
	if r.Status >= 300 {
		if len(text) > 500 {
			text = text[:500]
		}
		return "", "", &SAPError{Status: r.Status, Message: fmt.Sprintf("API Gateway ExportPDFData %s failed (%d): %s", layout, r.Status, text)}
	}
	// A bare JSON string is what the gateway sends; tolerate the two other shapes a Crystal endpoint
	// has been seen to use, and a raw base64 body, rather than guess wrong at 3am.
	var s string
	var wrapped struct{ Value, PDFData string }
	switch {
	case json.Unmarshal(r.Body, &s) == nil:
	case json.Unmarshal(r.Body, &wrapped) == nil:
		s = wrapped.Value
		if s == "" {
			s = wrapped.PDFData
		}
	default:
		s = text
	}
	if s == "" {
		return "", "", &SAPError{Status: 502, Message: "API Gateway returned no PDF data for " + layout}
	}
	return s, fmt.Sprintf("%s-%d.pdf", entity, docEntry), nil
}
