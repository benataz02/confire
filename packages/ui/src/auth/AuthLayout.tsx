import type { CSSProperties, ReactNode } from "react";
import "./AuthLayout.css";

/** Staggers a `.reveal` element's entrance: the CSS reads --d as its animation delay. */
export const revealDelay = (ms: number): CSSProperties => ({ ["--d" as string]: `${ms}ms` });

/** Branded split screen for the pages outside an app shell (login, signup, onboarding…): `brand` fills the
 *  presentational left panel — Confire's own in the internal app, the supplier's on the portal —
 *  and the form slots into the right. */
export function AuthLayout({ brand, children }: { brand: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-root">
      <aside className="auth-brand">
        <div className="auth-brand__inner">{brand}</div>
      </aside>
      <main className="auth-panel">
        <div className="auth-panel__form reveal" style={revealDelay(120)}>{children}</div>
      </main>
    </div>
  );
}
