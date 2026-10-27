//go:build windows

package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// The Windows service. A plain exe registered with sc.exe is killed by the Service Control Manager
// after ~30 s (error 1053) because it never answers it; x/sys/windows/svc does.

const serviceName = "ConfireAgent"

const canInstall = true

// bundled holds bin/cloudflared.exe: CI downloads the pinned release, checks its SHA-256 and drops
// it in before the build (apps/server/Dockerfile), so install day needs no download a proxy could
// block. A local build has only bin/.gitkeep and installs no tunnel.
//
//go:embed all:bin
var bundled embed.FS

func installDir() string        { return filepath.Join(os.Getenv("ProgramFiles"), "Confire", "Agent") }
func dataDir() string           { return filepath.Join(os.Getenv("ProgramData"), "Confire") }
func logDir() string            { return filepath.Join(dataDir(), "logs") }
func defaultConfigPath() string { return filepath.Join(dataDir(), "agent.json") }

func isWindowsService() bool {
	ok, _ := svc.IsWindowsService()
	return ok
}

var relaunched bool

// ensureAdmin re-launches this exe elevated (the UAC prompt) when it is not; the caller then just
// exits. At run time rather than in a manifest, so `run` and `version` never ask.
func ensureAdmin() (bool, error) {
	if windows.GetCurrentProcessToken().IsElevated() {
		return false, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return false, err
	}
	args := make([]string, len(os.Args)-1)
	for i, a := range os.Args[1:] {
		args[i] = syscall.EscapeArg(a)
	}
	cwd, _ := os.Getwd()
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString(strings.Join(args, " "))
	dir, _ := windows.UTF16PtrFromString(cwd)
	if err := windows.ShellExecute(0, verb, file, params, dir, windows.SW_NORMAL); err != nil {
		return false, fmt.Errorf("setup needs administrator rights: %w", err)
	}
	relaunched = true
	return true, nil
}

// initConsole turns on VT processing, which the wizard's colours need; false on a console without it
// (pre-Windows 10). The code page stays as it is: Go reads and writes a console in UTF-16 either way,
// and on Server 2012 R2 with code page 65001 set, WriteConsoleW failed every non-ASCII write ("A
// device attached to the system is not functioning"): each line with a ✓ or an — vanished.
func initConsole() bool {
	out := windows.Handle(os.Stdout.Fd())
	var mode uint32
	return windows.GetConsoleMode(out, &mode) == nil &&
		windows.SetConsoleMode(out, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING) == nil
}

// flushConsoleInput drops keys queued on the console; false when stdin is not one (a pipe).
func flushConsoleInput() bool {
	return windows.FlushConsoleInputBuffer(windows.Handle(os.Stdin.Fd())) == nil
}

// pause keeps a double-clicked window open long enough to read.
func pause() {
	if relaunched {
		return
	}
	fmt.Print("\nPress Enter to close this window.")
	fmt.Scanln()
}

// prepareConfigDir makes the config's folder readable by Administrators and SYSTEM only — agent.json
// holds SAP passwords — with what is created in it inheriting that.
func prepareConfigDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func withService(fn func(*mgr.Mgr, *mgr.Service) error) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fn(m, nil)
	}
	defer s.Close()
	return fn(m, s)
}

func isInstalled(string) bool {
	return withService(func(_ *mgr.Mgr, s *mgr.Service) error {
		if s == nil {
			return errors.New("not installed")
		}
		return nil
	}) == nil
}

func stopService(s *mgr.Service) error {
	st, err := s.Query()
	if err != nil || st.State == svc.Stopped {
		return err
	}
	if st.State != svc.StopPending {
		if _, err := s.Control(svc.Stop); err != nil {
			return err
		}
	}
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		if st, err := s.Query(); err != nil || st.State == svc.Stopped {
			return err
		}
	}
	return errors.New("the service did not stop within 30 s")
}

// install puts this exe and cloudflared under Program Files and (re)starts the service onto the
// saved config. The same steps update an installed agent: stop, replace, start.
func install() error {
	return withService(func(m *mgr.Mgr, s *mgr.Service) error {
		if s != nil {
			if err := stopService(s); err != nil {
				return err
			}
		}
		dir := installDir()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		exe := filepath.Join(dir, "confire-agent.exe")
		self, err := os.Executable()
		if err != nil {
			return err
		}
		if !strings.EqualFold(filepath.Clean(self), filepath.Clean(exe)) {
			if err := copyFile(self, exe); err != nil {
				return fmt.Errorf("copying the agent to %s: %w", dir, err)
			}
		}
		if cf, err := bundled.ReadFile("bin/cloudflared.exe"); err == nil {
			if err := os.WriteFile(filepath.Join(dir, "cloudflared.exe"), cf, 0o755); err != nil {
				return err
			}
		} else if !strings.EqualFold(filepath.Dir(self), dir) {
			return errors.New("this build carries no cloudflared: download the agent from Confire")
		}
		if err := os.MkdirAll(logDir(), 0o700); err != nil {
			return err
		}
		if s == nil {
			s, err = m.CreateService(serviceName, exe, mgr.Config{
				DisplayName: "Confire agent",
				Description: "Connects SAP Business One to Confire. Settings: confire-agent setup.",
				StartType:   mgr.StartAutomatic,
			})
			if err != nil {
				return err
			}
			defer s.Close()
			restartAfter := mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: 10 * time.Second}
			if err := s.SetRecoveryActions([]mgr.RecoveryAction{restartAfter, restartAfter, restartAfter}, 24*60*60); err != nil {
				return err
			}
		}
		return s.Start()
	})
}

func restart() error {
	return withService(func(_ *mgr.Mgr, s *mgr.Service) error {
		if s == nil {
			return errors.New("the service is not installed: run setup")
		}
		if err := stopService(s); err != nil {
			return err
		}
		return s.Start()
	})
}

// installedVersion asks the installed exe; "" when there is none.
func installedVersion() string {
	out, err := exec.Command(filepath.Join(installDir(), "confire-agent.exe"), "version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func uninstallAll(string) error {
	err := withService(func(_ *mgr.Mgr, s *mgr.Service) error {
		if s == nil {
			return nil
		}
		if err := stopService(s); err != nil {
			return err
		}
		return s.Delete()
	})
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dataDir()); err != nil {
		return err
	}
	// A running exe cannot delete itself: when this is the installed one, a detached cmd does it
	// once this process has exited.
	self, _ := os.Executable()
	if strings.EqualFold(filepath.Dir(self), installDir()) {
		cmd := exec.Command("cmd", "/c", "ping -n 3 127.0.0.1 >nul & rmdir /s /q \""+installDir()+"\"")
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS}
		return cmd.Start()
	}
	return os.RemoveAll(installDir())
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ---- Service mode ------------------------------------------------------------------------------

type service struct {
	log *log.Logger
	out io.Writer
}

func runService() {
	os.MkdirAll(logDir(), 0o700)
	out := &logFile{path: filepath.Join(logDir(), "agent.log")}
	svc.Run(serviceName, &service{log: log.New(out, "", log.LstdFlags), out: out})
}

func (s *service) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	cfg, err := loadConfig(defaultConfigPath())
	if err != nil {
		s.log.Print(err)
		return true, 1 // a service-specific failure: the recovery actions restart it
	}
	ctx, cancel := context.WithCancel(context.Background())
	var tunnel func(context.Context, *atomic.Bool)
	if cfg.TunnelToken != "" {
		self, _ := os.Executable()
		cloudflared := filepath.Join(filepath.Dir(self), "cloudflared.exe")
		tunnel = func(ctx context.Context, ready *atomic.Bool) {
			runTunnel(ctx, cloudflared, cfg.TunnelToken, s.out, s.log, ready)
		}
	}
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg, s.log, tunnel) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			cancel()
			s.log.Printf("agent stopped: %v", err)
			return true, 2
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				s.log.Print("agent stopped")
				return false, 0
			}
		}
	}
}

// logFile is agent.log, bounded: past 10 MB it becomes agent.log.1 (replacing the previous one).
type logFile struct {
	mu   sync.Mutex
	path string
	f    *os.File
	size int64
}

const maxLog = 10 << 20

func (l *logFile) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil && l.size+int64(len(p)) > maxLog {
		l.f.Close()
		l.f = nil
		os.Rename(l.path, l.path+".1")
	}
	if l.f == nil {
		f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return 0, err
		}
		st, _ := f.Stat()
		l.f, l.size = f, st.Size()
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}
