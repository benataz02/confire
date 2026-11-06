// The panel's box in px (Joule spec §3, §5.5–5.7), so card ↔ window can animate: Joule's card under the
// ShellBar at the right, or where it was dragged (kept inside the window), or the whole window.

export type Pos = { x: number; y: number };
export type Box = { left: number; top: number; width: number; height: number; radius: number };

export function clampPos(p: Pos, size: { width: number; height: number }, vw: number, vh: number): Pos {
  return {
    x: Math.max(0, Math.min(p.x, vw - size.width)),
    y: Math.max(0, Math.min(p.y, vh - size.height)),
  };
}

/** `top`: the undragged card's top, under the ShellBar. */
export function cardBox(s: { maximized: boolean; pos: Pos | null; vw: number; vh: number; top: number }): Box {
  if (s.maximized) return { left: 0, top: 0, width: s.vw, height: s.vh, radius: 0 };
  const width = Math.min(416, s.vw - 32);
  const height = s.vh - s.top - 16;
  const at = s.pos ? clampPos(s.pos, { width, height }, s.vw, s.vh) : { x: s.vw - 16 - width, y: s.top };
  return { left: at.x, top: at.y, width, height, radius: 16 };
}
