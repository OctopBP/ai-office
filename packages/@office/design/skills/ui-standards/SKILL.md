---
name: ui-standards
description: Compact reference of measurable UI/UX standards - WCAG 2.2 AA numbers, Nielsen heuristics, spacing grid, type scale, component states. Use when choosing colours, sizes, spacing or states, judging whether a layout is accessible, or looking up a threshold while designing or styling.
---

# UI standards (reference)

Own wording of public standards: WCAG 2.2 (W3C), 10 usability heuristics
(Nielsen Norman Group), 4/8-pt grid practice. No text is copied from third-party
skill sets. Project tokens win over generic values: `src/web/styles/tokens.css`.

## WCAG 2.2 AA, in numbers
- Text contrast >= 4.5:1; large text (>= 18 px, or >= 14 px bold) >= 3:1 (1.4.3).
- Non-text (field borders, icon buttons, state marks) >= 3:1 against neighbours (1.4.11).
- Contrast = (L1+0.05)/(L2+0.05), L = relative luminance; check each theme apart.
- Colour never the only carrier of meaning (1.4.1).
- Focus visible, ring >= 2 px, >= 3:1, not hidden by sticky bars (2.4.7, 2.4.11, 2.4.13).
- Target size >= 24x24 px or 24 px spacing (2.5.8). Touch: 44 pt (Apple) / 48 dp (Material).
- Everything operable by keyboard, no trap, Esc closes overlays (2.1.1, 2.1.2).
- Works at 200% zoom and wider text spacing (1.4.4, 1.4.12). Nothing flashes > 3/s (2.3.1).
- Respect `prefers-reduced-motion`.

## Nielsen heuristics (the ones that bite)
1 visible system status - 3 control and freedom (cancel, back, undo) - 4 consistency - 5 error prevention - 6 recognition over recall - 9 errors in plain words: what happened + what to do - 10 help where it is needed.

## Grid and spacing
Base 4 px, layout steps 8. Use `--space-*` only. Padding inside a group <= gap between groups (proximity). Align to a shared edge; same-role elements share size and radius.

## Type
Few sizes from the token scale (<= 6 on a screen), <= 2 families, <= 3 weights. Body >= 12 px; 10-11 px only for section labels and minor tags. Line-height 1.4-1.6 for prose; line length 45-80 chars. Russian runs 20-30% longer than English.

## States
Control: default, hover, focus, pressed, disabled, loading, error, selected.
Screen: empty, loading, error with retry, partial, full, no access / offline.
Disabled still readable; loading > 1 s shows progress.

## Motion
150-300 ms, ease-out in / ease-in out; only to show a state change; reducible.

## Desktop app (`desktop/`)
Platform shortcuts and menus: Cmd on macOS, Ctrl on Windows; window drag regions; do not invent keys for familiar actions.

## Copy
Verb on buttons; one word per action across the app; destructive actions named plainly and confirmable or undoable.
