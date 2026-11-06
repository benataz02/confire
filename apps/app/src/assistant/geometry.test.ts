import { expect, test } from "bun:test";
import { cardBox, clampPos } from "./geometry.ts";

// Where the panel sits (Joule spec §3): the card, dragged or not, and maximized to the window.

test("Joule's spot: 416 wide, 16 px from the right and bottom, under the ShellBar", () => {
  expect(cardBox({ maximized: false, pos: null, vw: 1440, vh: 900, top: 60 })).toEqual({ left: 1008, top: 60, width: 416, height: 824, radius: 16 });
});
test("maximized is the whole window with square corners, wherever the card was", () => {
  expect(cardBox({ maximized: true, pos: { x: 10, y: 10 }, vw: 1440, vh: 900, top: 60 })).toEqual({ left: 0, top: 0, width: 1440, height: 900, radius: 0 });
});
test("a narrow window narrows the card", () => {
  expect(cardBox({ maximized: false, pos: null, vw: 400, vh: 800, top: 60 }).width).toBe(368);
});
test("a dragged card stays where it was put, inside the window, over the ShellBar too", () => {
  expect(cardBox({ maximized: false, pos: { x: 200, y: 0 }, vw: 1440, vh: 900, top: 60 })).toMatchObject({ left: 200, top: 0 });
  expect(clampPos({ x: -50, y: 2000 }, { width: 416, height: 824 }, 1440, 900)).toEqual({ x: 0, y: 76 });
});
test("a window made smaller pulls a dragged card back into view", () => {
  expect(cardBox({ maximized: false, pos: { x: 1000, y: 40 }, vw: 1000, vh: 700, top: 60 })).toMatchObject({ left: 584, top: 40 });
});
