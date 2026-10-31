import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon } from "@ui5/webcomponents-react";
import { LANGUAGES, useLanguage, useUiI18n } from "../i18n.ts";
import "./AuthLayout.css";

// The pages before an app — sign-in, setup, the portal's invitation pages — in confire.ai's own look
// (spec 2026-10-31-auth-pages-redesign-design.md): the site's shell bar, hero background and one Fiori
// card. Fields and buttons are native, in a real <form>: password managers fill and save those, and
// UI5's Input has no `autocomplete`. Each SPA brings its brand and footer.

/** The frame: `brand` is the shell bar's left (Confire's, or the supplier's on the portal), `foot` the
 *  small print. `wide` for the pages with more in their card (Where to?, the SAP server step). */
export function AuthLayout({ brand, foot, wide, children }: {
  brand: ReactNode;
  foot: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="auth">
      <span className="auth-glow auth-glow--brand" aria-hidden="true" />
      <span className="auth-glow auth-glow--ai" aria-hidden="true" />
      <header className="auth-shell">
        <div className="auth-shell__in">{brand}<LanguageMenu /></div>
      </header>
      <main className="auth-main">
        <div className={wide ? "auth-col auth-col--wide" : "auth-col"}>{children}</div>
      </main>
      <footer className="auth-foot">{foot}</footer>
    </div>
  );
}

/** The user menu's language, here before there is a user menu (a native popover, like the site's). */
function LanguageMenu() {
  const i18n = useUiI18n();
  const { language, setLanguage } = useLanguage();
  const id = useId();
  return (
    <>
      <button type="button" className="auth-btn auth-btn--lite" popoverTarget={id} aria-label={i18n.getText("UI_AUTH_LANGUAGE")}>
        <Icon name="globe" />{language.toUpperCase()}
      </button>
      <div id={id} popover="auto" className="auth-menu">
        {LANGUAGES.map((l) => (
          <button
            key={l.id}
            type="button"
            lang={l.id}
            aria-current={l.id === language || undefined}
            onClick={(e) => {
              (e.currentTarget.parentElement as HTMLElement).hidePopover();
              setLanguage(l.id);
            }}
          >
            {l.label}{l.id === language ? <Icon name="sys-enter-2" /> : null}
          </button>
        ))}
      </div>
    </>
  );
}

/** The page's one heading, the display headline, with its lead. Headlines end in a full stop, so one
 *  ending in a name that has its own ("Join Acero Norte S.A..") keeps a single one. */
export function AuthHead({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <div className="auth-head">
      <h1>{title.replace(/\.\.$/, ".")}</h1>
      {lead ? <p>{lead}</p> : null}
    </div>
  );
}

/** The Fiori card. With `onSubmit` its panel is a <form>: Enter submits, and a password manager sees
 *  one. `center` for the confirmation states, `list` for Where to?'s rows. */
export function AuthCard({ onSubmit, center, list, children }: {
  onSubmit?: () => void;
  center?: boolean;
  list?: boolean;
  children: ReactNode;
}) {
  const cls = `auth-pane${center ? " auth-pane--center" : ""}${list ? " auth-pane--list" : ""}`;
  return (
    <div className="auth-rim">
      {onSubmit ? (
        <form className={cls} noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>{children}</form>
      ) : (
        <div className={cls}>{children}</div>
      )}
    </div>
  );
}

/** A labelled native input. `aside` sits at the label's right (Forgot password?), `error` is a
 *  Negative value state, `hint` the line under it. */
export function AuthField({ label, aside, error, hint, prefix, ...input }: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  aside?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  prefix?: string;
}) {
  const id = useId();
  const field = (
    <input
      id={id}
      className="auth-input"
      aria-invalid={error ? true : undefined}
      aria-describedby={error || hint ? `${id}-msg` : undefined}
      {...input}
    />
  );
  return (
    <div className="auth-field">
      <div className="auth-field__lab"><label htmlFor={id}>{label}</label>{aside}</div>
      {prefix ? <div className="auth-prefix"><span>{prefix}</span>{field}</div> : field}
      {error ? (
        <span id={`${id}-msg`} className="auth-field__msg"><Icon name="error" />{error}</span>
      ) : hint ? (
        <div id={`${id}-msg`} className="auth-hint">{hint}</div>
      ) : null}
    </div>
  );
}

export type Tone = "brand" | "positive" | "negative" | "ai";

/** Fiori's illustrated message, reduced to an icon in a soft tile: the confirmation states. */
export function AuthTile({ icon, tone = "brand" }: { icon: string; tone?: Tone }) {
  return <span className={`auth-tile auth-tile--${tone}`} aria-hidden="true"><Icon name={icon} /></span>;
}

/** An object status chip. */
export function AuthChip({ tone, icon, children }: { tone: "positive" | "negative" | "info" | "neutral"; icon?: string; children: ReactNode }) {
  return <span className={`auth-chip auth-chip--${tone}`}>{icon ? <Icon name={icon} /> : null}{children}</span>;
}

/** A setup's steps above its headline; `current` counts from 0, the ones before it are done. */
export function AuthSteps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="auth-steps">
      {steps.map((s, i) => (
        <li key={s} className={i < current ? "done" : i === current ? "on" : undefined} aria-current={i === current ? "step" : undefined}>
          <span className="n">{i < current ? <Icon name="accept" /> : i + 1}</span>{s}
        </li>
      ))}
    </ol>
  );
}

/** "Talleres Ibarra S.L." → "TI": the avatar of a name with no logo. */
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
