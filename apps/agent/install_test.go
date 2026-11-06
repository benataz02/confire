package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A dev build is always version "dev", so "newer" cannot tell a new dev exe from the installed one:
// setup offers to install it when the bytes differ (sameFile).
func TestSameFile(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	a, b, c := write("a.exe", "build 1"), write("b.exe", "build 1"), write("c.exe", "build 2")
	if !sameFile(a, b) {
		t.Error("identical builds differ")
	}
	if sameFile(a, c) {
		t.Error("different builds are the same")
	}
	if sameFile(a, filepath.Join(dir, "missing.exe")) {
		t.Error("a missing install is the same")
	}
}
