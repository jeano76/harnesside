import React from "react";
import { Box, Text } from "ink";
import { getCapabilities, borderStyleFor } from "./terminal.js";
import { SLASH_COMMANDS } from "../shared/slashCommands.js";

export interface SlashMenuItem {
  key: string;
  label: string;
  description: string;
}

// `/reset` and `/fastcheck` were removed from this list along with their
// implementations — there is no model re-derivation left to trigger and no gate
// left to toggle. They are not hidden behind a flag: the code that answered them
// is deleted, so a stale config key or a keybinding document cannot revive them.
//
// **목록의 정본은 `shared/slashCommands.ts` 다** (사용자 요구: 웹 프롬프트에서도
// 슬래시로 같은 명령을 쓰게). 예전엔 이 배열만 TUI 에 있었고 웹엔 아무것도
// 없었는데, **화면에 보이는 목록**이라 두 곳에 두면 반드시 하나가 뒤처진다.
// 여기서는 TUI 모양(`key/label/description`)으로 바꿔 **읽기만** 한다.
export const SLASH_MENU_ITEMS: SlashMenuItem[] = SLASH_COMMANDS.map((c) => ({
  key: c.key,
  label: c.label,
  description: c.description,
}));

export interface SlashMenuProps {
  /** The items left after typing-to-filter (a subset of SLASH_MENU_ITEMS,
   *  in the same relative order) — not necessarily all of them. */
  items: SlashMenuItem[];
  /** Index into `items` (the filtered list), not into SLASH_MENU_ITEMS. */
  selectedIndex: number;
  /** How many item rows this box may show, from `menuVisibleRows`. Defaults
   *  to sizing itself from the full list (see the function's doc comment). */
  visibleRows?: number;
}

/**
 * How many item rows the menu box should occupy.
 *
 * The previous behaviour was "always SLASH_MENU_ITEMS.length", justified as
 * avoiding the "menu height changing shifts everything below it" ghosting bug.
 * That fix worked, but it was paid for twice over and both costs were visible
 * in ordinary use:
 *
 *   - Typing `/q` matched ONE command and still drew 13 rows, 12 of them
 *     blank. The box's height was decoupled from its content, which is the
 *     opposite of what a popup should do.
 *   - On a 24-row terminal the 15-row box left 3 rows of conversation, so
 *     choosing a command made the transcript you were choosing it FROM
 *     disappear. Measured: rows=24 -> 3 log rows left; rows=30 -> 11.
 *
 * So: size to the content, bounded by a share of the available space, and
 * never below a usable minimum. The anti-ghosting property is kept where it
 * actually matters — the height is a pure function of (available rows, match
 * count) and does NOT vary as the selection moves, so holding an arrow key
 * down reflows nothing.
 */
export function menuVisibleRows(availableRows: number, matchCount: number): number {
  // A popup row needs its own border, so a box of N items occupies N + 2 rows.
  // The floor and the share are both computed on the ITEM budget and then
  // clamped against what the container can physically hold.
  //
  // The clamp is the fix. `Math.max(MIN_ROWS, ...)` made the floor unconditional
  // in the wrong direction: on a 20x10 terminal the log area is 5 rows, the
  // floor produced 4 items, and the box (4 + 2 borders) needed 6 -- so the
  // popup was drawn larger than the space it overlays and the transcript
  // behind it was pushed to nothing. Caught by the terminal simulation sweep,
  // which checks the box against the log height at 20x10 through 200x50.
  //
  // 3 items is the smallest box that still reads as a list rather than a
  // fragment (2 would leave a single visible item between two borders).
  const MIN_ROWS = 3;
  // A popup may claim at most this share of the log area; the conversation
  // has to stay readable while it is open.
  const MAX_SHARE = 0.5;
  const BORDER_ROWS = 2;
  const wanted = Math.max(MIN_ROWS, Math.floor(availableRows * MAX_SHARE));
  // Never taller than the container, borders included. A popup that overflows
  // its own overlay is not a popup.
  const ceiling = Math.max(1, availableRows - BORDER_ROWS);
  return Math.min(Math.max(1, matchCount), wanted, ceiling);
}

/**
 * Which slice of `items` to draw, given a fixed visible height and the
 * current selection. Scrolls just enough to keep the selection on screen, so
 * every command stays reachable even on a terminal too short to show them all
 * at once — an off-screen command the user can neither see nor reach is
 * worse than a tall box.
 */
export function menuWindow<T>(items: T[], selectedIndex: number, visibleRows: number): T[] {
  if (visibleRows <= 0 || items.length === 0) return [];
  if (items.length <= visibleRows) return items;
  const selected = Math.max(0, Math.min(items.length - 1, selectedIndex));
  // Centre the window, then clamp to both ends. The offset is
  // `floor(visibleRows / 2)` and NOT `floor(selected - visibleRows / 2)`: the
  // latter shifts a 1-row window to the item BEFORE the selection, so with a
  // single visible row the highlighted command is never the one on screen —
  // caught by the "selection is always inside the window" test.
  const start = Math.max(0, Math.min(items.length - visibleRows, selected - Math.floor(visibleRows / 2)));
  return items.slice(start, start + visibleRows);
}

/**
 * Ink re-renders the whole tree from state each frame, so this popup never
 * needs manual buffer save/restore (PROMPT.md §6) — it simply isn't in the
 * tree once `visible` is false, and the surrounding layout re-paints clean.
 * It's a self-contained Box, so it never reaches into or overwrites siblings.
 *
 * Renders exactly `visibleRows` item rows, padded with blanks when there are
 * fewer matches, so the box's height never changes as the user types or moves
 * the selection. When the list is longer than the window, `menuWindow`
 * scrolls it and the overflow rows say so explicitly.
 */
export function SlashMenu({ items, selectedIndex, visibleRows }: SlashMenuProps) {
  const caps = getCapabilities();
  const rows = visibleRows ?? menuVisibleRows(SLASH_MENU_ITEMS.length, items.length);
  const shown = menuWindow(items, selectedIndex, rows);
  const blankRows = Math.max(0, rows - shown.length);
  // `❯` is not ASCII; on a terminal that can't render it (non-UTF-8 locale,
  // see terminal.ts's detectUnicode) it would come out as `?` right at the
  // start of the selected row, and the selection marker is the one glyph a
  // user is actually reading to know where they are.
  const pointer = caps.unicode ? "❯" : ">";
  const shown0 = shown[0];
  const shownLast = shown[shown.length - 1];
  const hiddenAbove = shown.length > 0 && shown0 !== items[0];
  const hiddenBelow = shown.length > 0 && shownLast !== items[items.length - 1];
  // With the window scrolled, the highlight follows the selected item's
  // position WITHIN the window, not its absolute index.
  const localSelected = shown.findIndex((i) => i === items[selectedIndex]);

  return (
    <Box flexDirection="column" borderStyle={borderStyleFor(caps)} borderColor="cyan" paddingX={1}>
      {hiddenAbove && <Text dimColor>{caps.unicode ? "  ↑ 위 항목 있음" : "  ^ more above"}</Text>}
      {items.length === 0 ? (
        <Text dimColor>No matching commands</Text>
      ) : (
        shown.map((item, i) => (
          <Text key={item.key} color={i === localSelected ? "cyan" : undefined} inverse={i === localSelected}>
            {i === localSelected ? `${pointer} ` : "  "}{item.label.padEnd(15)} <Text dimColor={i !== localSelected}>{item.description}</Text>
          </Text>
        ))
      )}
      {hiddenBelow && <Text dimColor>{caps.unicode ? "  ↓ 아래 항목 있음" : "  v more below"}</Text>}
      {Array.from({ length: blankRows }, (_, i) => (
        <Text key={`blank-${i}`}> </Text>
      ))}
    </Box>
  );
}
