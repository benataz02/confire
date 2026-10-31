import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deploy/site.sh, the forced command of the site's deploy key (spec 2026-10-30 §11.2): a sha as the
// command, a gzipped tar of dist on stdin, an atomic switch of ~/site/current, five releases kept.

const SCRIPT = new URL("../../../deploy/site.sh", import.meta.url).pathname;

function tarball(page: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "site-dist-"));
  writeFileSync(join(dir, "index.html"), page);
  return Bun.spawnSync(["tar", "-C", dir, "-czf", "-", "."]).stdout;
}
const deploy = (home: string, command: string, stdin: Uint8Array) =>
  Bun.spawnSync(["sh", SCRIPT], { env: { HOME: home, PATH: process.env.PATH!, SSH_ORIGINAL_COMMAND: command }, stdin });
const live = (home: string) => readFileSync(join(home, "site/current/index.html"), "utf8");

test("a deploy goes live through the current link", () => {
  const home = mkdtempSync(join(tmpdir(), "site-home-"));
  const r = deploy(home, "abc1234", tarball("one"));
  expect(r.stdout.toString()).toBe("site abc1234 live\n");
  expect(readlinkSync(join(home, "site/current"))).toBe("releases/abc1234");
  expect(live(home)).toBe("one");
});

test("a sixth deploy prunes the oldest", () => {
  const home = mkdtempSync(join(tmpdir(), "site-home-"));
  for (let i = 1; i <= 6; i++) expect(deploy(home, `a00000${i}`, tarball(`v${i}`)).exitCode).toBe(0);
  expect(readdirSync(join(home, "site/releases")).sort()).toEqual(["a000002", "a000003", "a000004", "a000005", "a000006"]);
  expect(live(home)).toBe("v6");
});

test("redeploying a kept sha switches back to it (a rollback by re-run)", () => {
  const home = mkdtempSync(join(tmpdir(), "site-home-"));
  deploy(home, "b000001", tarball("old"));
  deploy(home, "b000002", tarball("new"));
  expect(deploy(home, "b000001", tarball("ignored")).exitCode).toBe(0);
  expect(live(home)).toBe("old");
});

test("anything but a sha is refused and changes nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "site-home-"));
  deploy(home, "abc1234", tarball("one"));
  for (const bad of ["x; rm -rf /", "", "abc", "ABC1234", "../../etc"]) {
    expect(deploy(home, bad, tarball("evil")).exitCode).not.toBe(0);
  }
  expect(readdirSync(join(home, "site/releases"))).toEqual(["abc1234"]);
  expect(live(home)).toBe("one");
});

test("a broken upload leaves the live site alone", () => {
  const home = mkdtempSync(join(tmpdir(), "site-home-"));
  deploy(home, "abc1234", tarball("one"));
  expect(deploy(home, "def5678", new TextEncoder().encode("not a tarball")).exitCode).not.toBe(0);
  expect(live(home)).toBe("one");
  expect(existsSync(join(home, "site/releases/def5678"))).toBe(false);
});
