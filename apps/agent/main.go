// The Confire agent: one exe on the customer's SAP server. It holds the SAP sessions, forwards an
// allowlist of Service Layer calls for Confire, prints through the API Gateway, and keeps a
// Cloudflare tunnel up so Confire can reach it — and it installs itself (spec 2026-10-21).
//
//	confire-agent [setup]      the wizard: first install, or change an installed one
//	confire-agent run          the server in the foreground, no service (dev)
//	confire-agent uninstall    stop and remove the service, its files and its config
//	confire-agent version
//
// Started by the Service Control Manager it runs as the Windows service, with cloudflared as its
// child. Windows-only code lives in *_windows.go, so Linux (B1 on HANA) is an addition, not a
// restructure; `run` and `setup` already work on a Linux dev box.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
)

// version is set by CI (-ldflags "-X main.version=YYYY.MM.DD.<run>"): orderable, so "newer" means
// something. A local build says dev.
var version = "dev"

// defaultServer is the only deployment that hands out the agent (spec A17). The dev build (`bun run
// build`) sets it to dev's: -X main.defaultServer=$CONFIRE_SERVER, else http://localhost:3000.
var defaultServer = "https://app.confire.ai"

func main() {
	if isWindowsService() {
		runService()
		return
	}
	cmd, args := "setup", os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("confire-agent "+cmd, flag.ExitOnError)
	config := fs.String("config", defaultConfigPath(), "path of agent.json")
	server := fs.String("server", defaultServer, "the Confire server to pair with (dev: http://localhost:3000)")
	fs.Parse(args)

	var err error
	switch cmd {
	case "setup":
		err = setup(*config, strings.TrimRight(*server, "/"))
	case "run":
		err = runForeground(*config)
	case "uninstall":
		err = uninstallCommand(*config)
	case "version":
		fmt.Println(version)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q: setup, run, uninstall or version\n", cmd)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
	}
	if cmd == "setup" || cmd == "uninstall" {
		pause()
	}
	if err != nil {
		os.Exit(1)
	}
}

// runForeground is `run`: the server alone, logging to the console, until Ctrl-C. No tunnel —
// in dev Confire reaches it on localhost.
func runForeground(path string) error {
	cfg, err := loadConfig(path)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return serve(ctx, cfg, log.New(os.Stderr, "", log.LstdFlags), nil)
}

// isNewer: a is a later build than b. Versions are YYYY.MM.DD.<run>; dev is never older or newer.
func isNewer(a, b string) bool {
	parse := func(v string) []int {
		var out []int
		for _, p := range strings.Split(v, ".") {
			n, err := strconv.Atoi(p)
			if err != nil {
				return nil
			}
			out = append(out, n)
		}
		return out
	}
	x, y := parse(a), parse(b)
	if x == nil || y == nil {
		return false
	}
	for i := 0; i < max(len(x), len(y)); i++ {
		var p, q int
		if i < len(x) {
			p = x[i]
		}
		if i < len(y) {
			q = y[i]
		}
		if p != q {
			return p > q
		}
	}
	return false
}
