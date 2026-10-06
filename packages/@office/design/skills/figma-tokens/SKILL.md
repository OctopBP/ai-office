---
name: figma-tokens
description: Use the Figma file's own variables and styles instead of inventing colours, spacing and type sizes. Use before setting any colour, font size or gap in Figma, and whenever the task mentions a design system, tokens, theme, palette, brand colours or consistency with existing screens.
---

# Work from the file's tokens, not from memory

A design that uses invented hex values is not a design — it is a picture that
resembles one. It cannot be themed, it drifts from every other screen, and the
first review sends it back. Before setting a single colour, size or gap, find
out what the file already defines.

## Read first

- `get_variable_defs` — variable collections, modes and values. This is Figma's
  design-token system: colours, numbers, strings, booleans. Collections usually
  carry the modes (Light / Dark), so a value is a value *per mode*.
- `get_styles` — local paint, text and effect styles. Older files carry their
  system here rather than in variables; many files have both.

Do this once at the start of the task and keep the result in mind — these are
whole-document reads, and calling them per node is wasteful.

## Then use what you found

- A colour that exists as a variable or style is the colour you use. Take its
  value and pass it as `fillHex`.
- Spacing and radius likewise: if the file defines a spacing scale, your
  `itemSpacing` and `padding*` come from it. Do not round to whatever looks
  fine — a 14px gap in a file whose scale is 4/8/12/16 is a defect.
- Type sizes come from the text styles. If a style says the body is 14/20, that
  is `fontSize: 14` and `lineHeightPx: 20`.
- Name your layers the way the file names things. A frame called `Frame 42`
  next to `Card / Product` is visibly foreign.

## Bind, do not copy values

The bridge sets **values**, not bindings: a frame filled with the value of
`color/surface` looks right and does not follow a mode switch. Binding is done
with `figma-console-mcp`: `figma_execute` (`setBoundVariable`,
`setBoundVariableForPaint`) or its variable tools. Colours, spacing, radii and
text sizes on your frames must be bound to variables, not just equal in value.

The variables mirror `src/web/styles/tokens.css`, light and dark modes in one
collection. If a value you need is not there, use the nearest existing one and
list the missing token in the report.

If binding was impossible (server not connected, no token), say so in the
report and list the tokens whose values you took, so they can be bound in one
pass. Do not present values-only work as finished.

## When the file has no tokens

It happens — an empty file, a scratch page, an early project. Then:

1. Say so in the report. "У файла нет переменных и стилей" is information the
   person needs, not a detail to swallow.
2. Create variables from `src/web/styles/tokens.css` (see above). Only if that
   file is unavailable, pick a small palette and a spacing scale, and hold to them for the whole
   task: four to six colours, spacing in multiples of 4, two or three type
   sizes. Consistency inside your own work is the part you control.
3. List the palette you used in the report, so it can become the file's tokens
   later instead of being reverse-engineered out of your frames.

## Do not redefine the system

Creating new variables or styles is not part of drawing an ordinary screen.
The exception is a file with no tokens: then mirror `tokens.css` into variables
first (`figma_setup_design_tokens` or `figma_batch_create_variables`), light
and dark, and bind to them. If the task
needs a token that does not exist, build with the nearest existing one and say
in the report what was missing. Quietly extending someone's design system is a
bigger decision than the task you were given.
