package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sync/atomic"
	"time"
)

// runTunnel keeps cloudflared connected until ctx ends: started with the token in its environment
// (never on a command line, where any local user could read it), restarted whenever it exits, and
// polled on its metrics /ready so /health can say whether the tunnel is up.
func runTunnel(ctx context.Context, exe, token string, out io.Writer, lg *log.Logger, ready *atomic.Bool) {
	for ctx.Err() == nil {
		metrics := freePort()
		cmd := exec.CommandContext(ctx, exe, "tunnel", "--no-autoupdate", "--metrics", fmt.Sprintf("127.0.0.1:%d", metrics), "run")
		cmd.Env = append(os.Environ(), "TUNNEL_TOKEN="+token)
		cmd.Stdout, cmd.Stderr = out, out
		if err := cmd.Start(); err != nil {
			lg.Printf("cloudflared did not start: %v", err)
		} else {
			done := make(chan struct{})
			go pollReady(metrics, ready, done)
			err := cmd.Wait()
			close(done)
			ready.Store(false)
			if ctx.Err() == nil {
				lg.Printf("cloudflared exited (%v); restarting", err)
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

func pollReady(port int, ready *atomic.Bool, done <-chan struct{}) {
	c := &http.Client{Timeout: 2 * time.Second}
	for {
		select {
		case <-done:
			return
		case <-time.After(2 * time.Second):
		}
		res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/ready", port))
		if err == nil {
			res.Body.Close()
		}
		ready.Store(err == nil && res.StatusCode == 200)
	}
}

// freePort is a port nothing listens on right now.
func freePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 20241
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// agentPort is 4000 when it is free, else any free port; pairing sends it so the tunnel's ingress
// points at it.
func agentPort() int {
	l, err := net.Listen("tcp", "127.0.0.1:4000")
	if err != nil {
		return freePort()
	}
	l.Close()
	return 4000
}
