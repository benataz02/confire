import { useEffect, useRef } from "react";

// The AI page's backdrop before the first message: the site's 22 px dot grid under two crossing waves
// and a ripple from a drifting centre, swelling and fading in slow patches, in Confire's blue blending
// into the assistant's purple. The colours are read off the theme each frame, so a theme switch follows
// without a reload; reduced motion draws one still frame.

const GAP = 22;
const STOPS = ["--sapBrandColor", "--sapAssistant_Color1", "--sapAssistant_Color2"];

/** A fixed 0–1 per dot, so neighbours never pulse in lockstep. */
const jitter = (i: number, j: number) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };

export function WavingDots() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, frame = 0, key = "", fill: CanvasGradient | null = null;

    const resize = () => {
      const dpr = devicePixelRatio || 1;
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      key = "";
      if (still) draw(4000);
    };
    const draw = (t: number) => {
      const style = getComputedStyle(canvas);
      const colours = STOPS.map((v) => style.getPropertyValue(v).trim() || "transparent");
      if (colours.join() !== key) {
        key = colours.join();
        fill = ctx.createLinearGradient(0, h, w, 0);
        colours.forEach((c, i) => fill!.addColorStop(i / (colours.length - 1), c));
      }
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = fill!;
      // The ripple's centre wanders a slow loop around the page.
      const cx = w * (0.5 + 0.35 * Math.sin(t * 0.00013)), cy = h * (0.5 + 0.3 * Math.cos(t * 0.00017));
      for (let i = 0, x = GAP / 2; x < w + GAP; i++, x += GAP) {
        for (let j = 0, y = GAP / 2; y < h + GAP; j++, y += GAP) {
          const r = Math.hypot(x - cx, y - cy);
          const wave = (Math.sin(x * 0.011 + y * 0.004 - t * 0.0009)
            + 0.7 * Math.sin(-x * 0.005 + y * 0.014 - t * 0.0013 + 1.7)
            + 0.6 * Math.sin(r * 0.028 - t * 0.0021)) / 2.3;
          const patch = 0.5 + 0.25 * (Math.sin(x * 0.003 + y * 0.002 + t * 0.00031)
            + Math.sin(-x * 0.0022 + y * 0.0037 - t * 0.00023));
          const k = jitter(i, j);
          const lift = ((wave + 1) / 2) ** 1.6 * (0.45 + 0.55 * patch) * (0.75 + 0.5 * k);
          ctx.globalAlpha = Math.min(0.12 + lift * 0.55, 0.7);
          ctx.beginPath();
          ctx.arc(x + wave * 3 * (k - 0.5), y + wave * 6, 0.7 + lift * 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    const loop = (t: number) => { draw(t); frame = requestAnimationFrame(loop); };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    if (!still) frame = requestAnimationFrame(loop);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  return (
    <canvas ref={ref} aria-hidden style={{
      position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: -1, pointerEvents: "none",
    }} />
  );
}
