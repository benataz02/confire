package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Direct printing (print spec §5.2): confire-print.exe renders the layout with the box's Crystal
// runtime. It is the agent's child, like cloudflared: the SQL login reaches it through its
// environment, never its command line, and it listens nowhere — one JSON line in, one out.

func crystalEnv(cfg *Config) []string {
	return append(os.Environ(),
		"CONFIRE_SQL_SERVER="+cfg.Crystal.Server,
		"CONFIRE_SQL_USER="+cfg.Crystal.User,
		"CONFIRE_SQL_PASS="+cfg.Crystal.Pass,
		// B1's company is its SQL database, so the engine cannot print another company than B1 reads.
		"CONFIRE_COMPANY_DB="+cfg.CompanyDb,
	)
}

// checkCrystal is the wizard's test: the SQL login, the company's RDOC and the Crystal runtime. It
// answers the child's own line on success (`ok Crystal 13.0.31.4010`) and its reason on failure.
func checkCrystal(exe string, cfg *Config) (string, error) {
	cmd := exec.Command(exe, "--check")
	cmd.Env = crystalEnv(cfg)
	out, err := cmd.CombinedOutput()
	msg := strings.TrimSpace(string(out))
	if err != nil {
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(msg)
	}
	return msg, nil
}

// crystalChild runs the print service and talks to it, restarting it on the print after it dies.
// ponytail: one child, prints in series — a small pool if prints ever queue.
type crystalChild struct {
	exe     string
	env     []string
	timeout time.Duration
	log     *log.Logger

	mu   sync.Mutex
	in   io.WriteCloser
	out  *bufio.Reader
	cmd  *exec.Cmd
	done chan struct{} // closed when cmd has exited
}

func newCrystalChild(exe string, env []string, timeout time.Duration, lg *log.Logger) *crystalChild {
	return &crystalChild{exe: exe, env: env, timeout: timeout, log: lg}
}

// start runs the child unless it is running; with c.mu held.
func (c *crystalChild) start() error {
	if c.cmd != nil {
		select {
		case <-c.done:
			c.cmd = nil
		default:
			return nil
		}
	}
	cmd := exec.Command(c.exe)
	cmd.Env = c.env
	cmd.Stderr = c.log.Writer()
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		err := cmd.Wait()
		c.log.Printf("print service exited (%v)", err)
		close(done)
	}()
	c.cmd, c.in, c.out, c.done = cmd, in, bufio.NewReaderSize(out, 1<<20), done
	return nil
}

// stop kills the child and waits for it; with c.mu held.
func (c *crystalChild) stop() {
	if c.cmd == nil {
		return
	}
	c.in.Close()
	c.cmd.Process.Kill()
	<-c.done
	c.cmd = nil
}

func (c *crystalChild) Render(layout string, docEntry int64, objectID int) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.start(); err != nil {
		return "", &SAPError{Status: 502, Message: "Direct printing could not start the print service: " + err.Error()}
	}
	line, _ := json.Marshal(map[string]any{"layout": layout, "docEntry": docEntry, "objectId": objectID})
	type answer struct {
		line []byte
		err  error
	}
	got := make(chan answer, 1)
	out := c.out
	go func() {
		b, err := out.ReadBytes('\n')
		got <- answer{b, err}
	}()
	if _, err := c.in.Write(append(line, '\n')); err != nil {
		c.stop()
		return "", &SAPError{Status: 502, Message: "Direct printing: the print service stopped; the next print starts it again."}
	}
	select {
	case a := <-got:
		var res struct {
			PDF   string `json:"pdf"`
			Error string `json:"error"`
		}
		if a.err != nil || json.Unmarshal(a.line, &res) != nil {
			c.stop()
			return "", &SAPError{Status: 502, Message: "Direct printing: the print service stopped; the next print starts it again."}
		}
		if res.Error != "" {
			return "", &SAPError{Status: 400, Message: "Direct printing: " + res.Error}
		}
		return res.PDF, nil
	case <-time.After(c.timeout):
		c.stop()
		return "", &SAPError{Status: 504, Message: fmt.Sprintf("Direct printing took longer than %d s; the print service was restarted.", int(c.timeout.Seconds()))}
	}
}

// Warm starts the child ahead of the first print, so that print does not pay Crystal's load.
func (c *crystalChild) Warm() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.start(); err != nil {
		c.log.Printf("print service did not start: %v", err)
	}
}

func (c *crystalChild) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stop()
}
