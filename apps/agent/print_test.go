package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// /print renders the layout Confire resolved (print spec §5.2): the agent checks it belongs to the
// entity — a leaked secret still prints only these four document types — and hands it to an engine.

// fakeGateway is the API Gateway's Reporting Service: a login, then ExportPDFData answering a bare
// JSON string of base64, as the live one does. It records what it was asked to export.
func fakeGateway(t *testing.T) (*httptest.Server, *struct{ docCode, docKey string }) {
	got := &struct{ docCode, docKey string }{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login":
			http.SetCookie(w, &http.Cookie{Name: "B1SESSION", Value: "x", Path: "/"})
			w.Write([]byte(`{}`))
		case "/rs/v1/ExportPDFData":
			got.docCode = r.URL.Query().Get("DocCode")
			var body []struct {
				Name  string     `json:"name"`
				Value [][]string `json:"value"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if len(body) == 1 && body[0].Name == "DocKey@" {
				got.docKey = body[0].Value[0][0]
			}
			w.Write([]byte(`"JVBERi0="`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

func testAgent(t *testing.T, gatewayURL string) *Agent {
	cfg := &Config{Secret: "s", CompanyDb: "SBODEMO", B1: Service{URL: "http://127.0.0.1:1"}}
	if gatewayURL != "" {
		cfg.Print = &Print{URL: gatewayURL, User: "u", Pass: "p"}
	}
	a, err := newAgent(cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func postPrint(a *Agent, body map[string]any) (int, map[string]any) {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/print", strings.NewReader(string(raw)))
	req.Header.Set("Authorization", "Bearer s")
	req.Header.Set("X-Confire-Company", "SBODEMO")
	rec := httptest.NewRecorder()
	a.routes().ServeHTTP(rec, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func errCode(out map[string]any) any {
	e, _ := out["error"].(map[string]any)
	return e["code"]
}

func TestPrintChecksTheLayoutAgainstTheEntity(t *testing.T) {
	gw, _ := fakeGateway(t)
	a := testAgent(t, gw.URL)
	cases := []struct {
		entity   string
		docEntry any
		layout   string
		engine   string
		want     int
	}{
		{"Quotations", 5, "QUT20009", "", 200},
		{"Quotations", 5, "QUT10001", "gateway", 200},
		{"Invoices", 7, "INV20017", "", 200},
		{"Orders", 5, "QUT20009", "", 403}, // another entity's layout
		{"Quotations", 5, "QUT2000;x", "", 403},
		{"Quotations", 5, "QUT", "", 403},
		{"Quotations", 5, "", "", 403},
		{"Items", 5, "ITM0001", "", 400}, // not printable
		{"Quotations", 0, "QUT20009", "", 400},
		{"Quotations", 1.5, "QUT20009", "", 400},
		{"Quotations", 5, "QUT20009", "pdfjs", 400}, // no such engine
	}
	for _, c := range cases {
		status, out := postPrint(a, map[string]any{"entity": c.entity, "docEntry": c.docEntry, "layout": c.layout, "engine": c.engine})
		if status != c.want {
			t.Errorf("%s %v %q %q: status %d, want %d (%v)", c.entity, c.docEntry, c.layout, c.engine, status, c.want, out)
		}
		if c.want == 403 && errCode(out) != "AGENT_REFUSED" {
			t.Errorf("%s %q: code %v, want AGENT_REFUSED", c.entity, c.layout, errCode(out))
		}
	}
}

func TestPrintGatewayExportsTheGivenLayout(t *testing.T) {
	gw, got := fakeGateway(t)
	status, out := postPrint(testAgent(t, gw.URL), map[string]any{"entity": "Quotations", "docEntry": 5, "layout": "QUT20009"})
	if status != 200 || out["pdf"] != "JVBERi0=" || out["fileName"] != "Quotations-5.pdf" {
		t.Fatalf("got %d %v", status, out)
	}
	if got.docCode != "QUT20009" || got.docKey != "5" {
		t.Fatalf("exported DocCode %q DocKey@ %q", got.docCode, got.docKey)
	}
}

func TestPrintCrystalNotSetUp(t *testing.T) {
	gw, _ := fakeGateway(t)
	status, out := postPrint(testAgent(t, gw.URL), map[string]any{"entity": "Quotations", "docEntry": 5, "layout": "QUT20009", "engine": "crystal"})
	e, _ := out["error"].(map[string]any)
	if status != 503 || !strings.Contains(e["message"].(string), "agent's setup") {
		t.Fatalf("got %d %v", status, out)
	}
}

func TestHealthReportsEngines(t *testing.T) {
	gw, _ := fakeGateway(t)
	rec := httptest.NewRecorder()
	testAgent(t, gw.URL).routes().ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	var out struct {
		Services struct {
			Print map[string]bool `json:"print"`
		} `json:"services"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if p := out.Services.Print; len(p) != 2 || !p["gateway"] || p["crystal"] {
		t.Fatalf("services.print = %s", rec.Body.String())
	}
}
