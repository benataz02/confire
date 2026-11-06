package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// The Direct engine's child (print spec §5.2) is faked by this test binary: run with
// CONFIRE_FAKE_PRINT=1 it speaks confire-print.exe's protocol, one JSON line in, one out.
func TestMain(m *testing.M) {
	if os.Getenv("CONFIRE_FAKE_PRINT") == "1" {
		fakePrintChild()
		return
	}
	os.Exit(m.Run())
}

func fakePrintChild() {
	pass := os.Getenv("SQL_PASS")
	leaked := pass == "" || strings.Contains(strings.Join(os.Args, " "), pass)
	if len(os.Args) > 1 && os.Args[1] == "--check" {
		if leaked {
			fmt.Println("Login failed for user 'sa'.")
			os.Exit(1)
		}
		fmt.Println("ok Crystal 13.0.31.4010")
		os.Exit(0)
	}
	in := bufio.NewScanner(os.Stdin)
	out := json.NewEncoder(os.Stdout)
	for in.Scan() {
		var req struct {
			Layout   string `json:"layout"`
			DocEntry int64  `json:"docEntry"`
			ObjectID int    `json:"objectId"`
		}
		json.Unmarshal(in.Bytes(), &req)
		ok := func() {
			if leaked {
				out.Encode(map[string]string{"error": "no password in the environment, or one on the command line"})
				return
			}
			out.Encode(map[string]string{"pdf": base64.StdEncoding.EncodeToString(fmt.Appendf(nil, "%s:%d:%d", req.Layout, req.DocEntry, req.ObjectID))})
		}
		switch req.Layout {
		case "QUT29999":
			out.Encode(map[string]string{"error": "boom"})
		case "QUT28888":
			select {}
		case "QUT27777":
			os.Exit(3)
		case "QUT26666":
			time.Sleep(100 * time.Millisecond)
			ok()
		default:
			ok()
		}
	}
}

func fakeCrystal(t *testing.T, timeout time.Duration) *crystalChild {
	t.Setenv("CONFIRE_FAKE_PRINT", "1")
	cfg := &Config{CompanyDb: "SBODEMO", Crystal: &Crystal{Server: "sql01", User: "sa", Pass: "s3cret"}}
	c := newCrystalChild(os.Args[0], crystalEnv(cfg), timeout, log.New(io.Discard, "", 0))
	t.Cleanup(c.Close)
	return c
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func sapStatus(err error) int {
	var e *SAPError
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

func TestCrystalRenders(t *testing.T) {
	pdf, err := fakeCrystal(t, 5*time.Second).Render("QUT20009", 5, 23)
	if err != nil || pdf != b64("QUT20009:5:23") {
		t.Fatalf("got %q, %v", pdf, err)
	}
}

func TestCrystalPasswordOnlyInEnvironment(t *testing.T) {
	// The fake refuses unless SQL_PASS is in its environment and nowhere on its command line.
	if _, err := fakeCrystal(t, 5*time.Second).Render("QUT20009", 5, 23); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CONFIRE_FAKE_PRINT", "1")
	if got, err := checkCrystal(os.Args[0], &Config{CompanyDb: "SBODEMO", Crystal: &Crystal{Server: "sql01", User: "sa", Pass: "s3cret"}}); err != nil || got != "ok Crystal 13.0.31.4010" {
		t.Fatalf("check: %q, %v", got, err)
	}
	t.Setenv("SQL_PASS", "a system-wide one") // the agent's own (empty) value must win over it
	if _, err := checkCrystal(os.Args[0], &Config{CompanyDb: "SBODEMO", Crystal: &Crystal{Server: "sql01", User: "sa"}}); err == nil || !strings.Contains(err.Error(), "Login failed") {
		t.Fatalf("check without a password: %v", err)
	}
}

func TestCrystalErrorReply(t *testing.T) {
	_, err := fakeCrystal(t, 5*time.Second).Render("QUT29999", 5, 23)
	if sapStatus(err) != 400 || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("got %v", err)
	}
}

func TestCrystalTimeoutRestarts(t *testing.T) {
	c := fakeCrystal(t, 200*time.Millisecond)
	if _, err := c.Render("QUT28888", 5, 23); sapStatus(err) != 504 {
		t.Fatalf("hung print: %v", err)
	}
	if pdf, err := c.Render("QUT20009", 6, 23); err != nil || pdf != b64("QUT20009:6:23") {
		t.Fatalf("after the restart: %q, %v", pdf, err)
	}
}

func TestCrystalChildDeathRecovers(t *testing.T) {
	c := fakeCrystal(t, 5*time.Second)
	if _, err := c.Render("QUT27777", 5, 23); sapStatus(err) != 502 {
		t.Fatalf("dead child: %v", err)
	}
	if _, err := c.Render("QUT20009", 5, 23); err != nil {
		t.Fatalf("after the death: %v", err)
	}
}

func TestCrystalOneAtATime(t *testing.T) {
	c := fakeCrystal(t, 5*time.Second)
	c.Warm()
	start := time.Now()
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func() { defer wg.Done(); _, errs[i] = c.Render("QUT26666", int64(i+1), 23) }()
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil {
		t.Fatalf("errors: %v", errs)
	}
	if d := time.Since(start); d < 200*time.Millisecond {
		t.Fatalf("two 100 ms prints took %v: they ran at once", d)
	}
}

func TestPrintCrystalEngine(t *testing.T) {
	a := testAgent(t, "")
	a.crystal = fakeCrystal(t, 5*time.Second)
	status, out := postPrint(a, map[string]any{"entity": "Quotations", "docEntry": 5, "layout": "QUT20009", "engine": "crystal"})
	if status != 200 || out["pdf"] != b64("QUT20009:5:23") || out["fileName"] != "Quotations-5.pdf" {
		t.Fatalf("got %d %v", status, out)
	}
	if status, out := postPrint(a, map[string]any{"entity": "Quotations", "docEntry": 5, "layout": "QUT29999", "engine": "crystal"}); status != 424 {
		t.Fatalf("error reply: %d %v", status, out)
	}
	rec := httptest.NewRecorder()
	a.routes().ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	if !strings.Contains(rec.Body.String(), `"crystal":true`) {
		t.Fatalf("health: %s", rec.Body.String())
	}
}
