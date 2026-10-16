import { useEffect, useRef } from "react";

// Cloudflare Turnstile, explicit rendering — one script tag, no package. The token goes to Better
// Auth's captcha plugin as x-captcha-response (auth-client.ts `captcha`). Tokens are single-use,
// so the page bumps `epoch` after every attempt and this renders a fresh widget.

type Widget = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window { turnstile?: Widget }
}

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "";
let script: Promise<void> | null = null;
const load = () =>
  (script ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { script = null; reject(new Error("Turnstile did not load")); };
    document.head.append(s);
  }));

export function Turnstile({ onToken, epoch, action }: {
  onToken: (token: string | null) => void;
  /** bump to replace a used token with a fresh widget */
  epoch: number;
  /** Turnstile `action`, shown in its analytics — which form this was */
  action: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id: string | undefined;
    let gone = false;
    load().then(() => {
      if (gone || !el.current || !window.turnstile) return;
      id = window.turnstile.render(el.current, {
        sitekey: SITE_KEY,
        action,
        callback: (t: string) => onToken(t),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    }, () => onToken(null));
    return () => {
      gone = true;
      onToken(null);
      if (id) window.turnstile?.remove(id);
    };
  }, [epoch, action, onToken]);
  return <div ref={el} className="auth-captcha" />;
}
