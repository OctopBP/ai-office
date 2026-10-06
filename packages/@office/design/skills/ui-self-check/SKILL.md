---
name: ui-self-check
description: Self-review checklist to run before handing over a mockup or finished UI markup. Use right before finish_task on any task that produced a screen, component, Figma frame or CSS/React UI code, and when asked to review or polish an interface.
---

# Self-check before handoff

Go through every section. In the report write one line per section:
`passed` or `violated: <what, where, why left as is>`. A bare "all ok" is not
a result. Numbers (contrast, sizes) must be computed, not eyeballed. Reference
values: `ui-standards` skill.

## A. Tokens and grid
- Every colour, gap, radius, font size is a token from `src/web/styles/tokens.css` (in Figma: a file variable). No raw hex or px outside the scale; need a new value — propose a new token separately.
- All gaps are multiples of 4; gap inside a group is smaller than between groups.
- New element resembles an existing one from `kit.css`; if it differs, say why.
- Type: only sizes from the scale, at most 3 weights on a screen.

## B. Accessibility
- Contrast of each text colour pair computed, in BOTH themes; name the 3 weakest pairs. Text >= 4.5:1 (large >= 3:1); borders, icon buttons >= 3:1.
- Every interactive element has a visible focus (>= 2px, >= 3:1); Tab order = reading order.
- Hit areas >= 24x24 px. Status is never colour alone: add icon or word.
- Animation <= 300 ms and off under `prefers-reduced-motion`.

## C. States
- Screen: empty, loading, error (with retry), partial, full.
- Control: default, hover, focus, pressed, disabled (+ selected, error where relevant).
- Extremes: very long text, 0 and 1000 items, Russian string 20-30% longer than English (truncate with ellipsis + tooltip).

## D. Nielsen, one line each: where it holds
System status visible; undo / way out; consistent words and elements; error prevention (confirm destructive); recognition over recall; errors say what happened + what to do.

## E. Copy
Buttons are verbs, not "OK". No error codes shown to a person. Strings exist in both `i18n` dictionaries (code tasks).

## F. Figma (design tasks)
- Auto Layout on every frame holding a row, column or list; no manual positions where layout can do it.
- Anything repeated twice or more is a component or an instance; variants instead of copies.
- Variables for colour/gap/radius; layers named by meaning (`Row/Task`, not `Frame 427`).
- Light and dark versions delivered side by side; states placed next to the screen.
- Screenshot taken with `get_screenshot` and looked at, not built blind.

## G. Markup (code tasks)
Semantic tags (`button`, `label`, `nav`); `aria-*` only where native semantics are missing; 200% zoom does not break the layout; checked in both themes.
