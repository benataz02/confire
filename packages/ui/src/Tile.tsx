import { Link } from "@tanstack/react-router";
import { Icon } from "@ui5/webcomponents-react";
import "./tile.css";

// A launchpad tile (Fiori's 11rem square; `wide` flexes in a HeroBanner), shared by the staff home and
// the portal home. A tile's count is a to-do; with `to` it opens its list, without it is a figure.

export type TileProps = {
  title: string;
  subtitle?: string;
  icon?: string;
  value?: string | number;
  unit?: string;
  state?: "Critical" | "Negative";
  /** tenant-relative (`/configs`); no `to` = a figure, not a link */
  to?: string;
  search?: Record<string, string>;
  wide?: boolean;
  /** the value is on its way: a shimmer bar (global.css' skeleton) holds its place */
  loading?: boolean;
};

export function Tile({ to, search, wide, loading, ...c }: TileProps) {
  const body = (
    <>
      <span className="cf-tile-title">{c.title}</span>
      {c.subtitle && <span className="cf-tile-sub">{c.subtitle}</span>}
      <span className="cf-tile-foot">
        {c.icon && <Icon name={c.icon} className="cf-tile-icon" />}
        {loading && <span className="cf-tile-num"><span className="confire-op-skel-bar" style={{ width: "2.5rem", height: "2rem" }} /></span>}
        {!loading && c.value !== undefined && (
          <span className={`cf-tile-num ${c.state ?? ""}`}>{c.value}{c.unit && <small>{c.unit}</small>}</span>
        )}
      </span>
    </>
  );
  const className = wide ? "cf-tile cf-tile-wide" : "cf-tile";
  // A real <a>: keyboard, middle-click and "open in new tab" come with it.
  return to
    ? <Link to={`/$slug${to}` as string} search={search} className={className}>{body}</Link>
    : <div className={className}>{body}</div>;
}
