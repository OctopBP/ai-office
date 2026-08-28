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

## The limitation, stated plainly

The bridge sets **values**, not bindings: there is no tool to attach a variable
to a node property. A frame filled with the value of `color/surface` will look
right and will not follow a mode switch.

Do not hide this. In your report, list which tokens you took values from, so a
person can bind them in one pass. Wording that works: "цвета взяты по значениям
переменных `color/surface`, `color/text/primary`; привязать их к свойствам
мостом нельзя — это делается в Figma руками."

## When the file has no tokens

It happens — an empty file, a scratch page, an early project. Then:

1. Say so in the report. "У файла нет переменных и стилей" is information the
   person needs, not a detail to swallow.
2. Pick a small palette and a spacing scale, and hold to them for the whole
   task: four to six colours, spacing in multiples of 4, two or three type
   sizes. Consistency inside your own work is the part you control.
3. List the palette you used in the report, so it can become the file's tokens
   later instead of being reverse-engineered out of your frames.

## Do not redefine the system

Creating new variables or styles is not part of drawing a screen. If the task
needs a token that does not exist, build with the nearest existing one and say
in the report what was missing. Quietly extending someone's design system is a
bigger decision than the task you were given.
