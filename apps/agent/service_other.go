//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// Not Windows: the dev box. No service to install — `run` is the server, and `setup` writes the
// config it reads. Linux as a real target (B1 on HANA) replaces this file with a systemd one.

const canInstall = false

func defaultConfigPath() string { return "agent.json" }
func logDir() string            { return "." }

func isWindowsService() bool          { return false }
func runService()                     {}
func ensureAdmin() (bool, error)      { return false, nil }
func initConsole() bool               { return true }
func flushConsoleInput() bool         { return false }
func pause()                          {}
func install() error                  { return nil }
func restart() error                  { return nil }
func installedVersion() string        { return "" }
func prepareConfigDir(d string) error { return os.MkdirAll(d, 0o700) }

// isInstalled: a dev agent is "installed" once its config exists, so setup offers its changes.
func isInstalled(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func uninstallAll(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Printf("Removed %s.\n", filepath.Clean(path))
	return nil
}
