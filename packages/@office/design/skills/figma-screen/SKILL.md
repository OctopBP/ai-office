---
name: figma-screen
description: Build or update a screen, page, card, modal or any multi-part layout in Figma through the figma-bridge MCP server. Use whenever the task is to draw, lay out, restructure or extend something in a Figma file — "сделай экран", "нарисуй макет", "собери карточку", "поправь layout". Covers the required call order, auto-layout discipline, node-id format and how to verify the result.
---

# Building a screen with figma-bridge

The `mcp__figma-bridge__*` tools drive a Figma file that is open in the desktop
app with the Figma MCP Bridge plugin running. Everything below is about that
bridge specifically — it is not the official Figma MCP and has a different tool
set.

## Order of work

1. `list_files` — always first. It returns `fileKey` and `fileName` per
   connected file. If more than one file is connected, **every** later call
   needs an explicit `fileKey`; without it the call may land in the wrong file.
2. `get_metadata` — file name, pages, current page. Confirms you are about to
   work where you think you are.
3. `get_selection` — if the person left something selected, that is almost
   always the thing they are talking about. Check before asking.
4. Read before you write: `get_document` or `get_node` for the area you are
   changing. Never restructure a node you have not looked at.
5. Build, then verify with `get_screenshot` (see below).

If the tools answer that there is no connection, the plugin is not open in the
file. Say so plainly in the report and stop — a written description is not a
substitute for the design you were asked to make.

## Node ids

Ids look like `1234:5678`. **Never use hyphens.** Figma URLs contain
`node-id=1234-5678`; converting a URL to an id means replacing the hyphen with
a colon. Ids copied straight from a URL are the most common cause of "node not
found".

Instance children look like `I12740:17806;12740:17793` — pass them through
unchanged.

## Structure: auto-layout, not coordinates

A screen assembled from absolutely positioned rectangles looks right in the
screenshot and is worthless in the file: nothing reflows, nothing can be
resized, and every later edit is manual. Assume the result will be edited by a
human, and build it the way a human would.

- Create the root frame with `create_frame` (name it), then immediately give it
  auto-layout with `set_auto_layout`: `layoutMode: 'VERTICAL' | 'HORIZONTAL'`,
  `itemSpacing`, and the four `padding*` values.
- Use `primaryAxisSizingMode: 'AUTO'` / `counterAxisSizingMode: 'AUTO'` for
  anything that should hug its contents — cards, buttons, list rows. Fixed
  sizes belong to the outer canvas frame, not to the pieces inside it.
- Nest by passing `parentId` **at creation time** (`create_frame`,
  `create_text`, `create_shape` all take it). Creating loose nodes and then
  reparenting them is more calls and leaves stray nodes behind when a step
  fails.
- `primaryAxisAlignItems: 'SPACE_BETWEEN'` is how a header row gets its title on
  the left and its actions on the right. Do not fake it with padding.
- Only reach for `x`/`y` on nodes that genuinely float: the top-level canvas
  frame on the page, and overlays.

## Text

`create_text` with `characters`, `parentId` and `fontSize`. Font defaults to
Inter Regular; if you need another face, pass both `fontFamily` and
`fontStyle` — a style that the family does not have will fail the call.

Set `textAutoResize: 'HEIGHT'` for paragraphs inside an auto-layout column so
the text wraps at the column width instead of running off. `'WIDTH_AND_HEIGHT'`
is for short labels that should hug.

## Colour and radius

Fills are hex here (`fillHex: '#1E88E5'`), not the 0–1 triples of the Plugin
API. `create_frame`, `create_shape` and `create_text` accept the fill inline —
use that instead of a separate `set_solid_fill` call. `set_solid_fill` is for
changing a fill afterwards, and it also does strokes via `target: 'stroke'`.

Corner radius is on `create_shape` and `set_node_properties`, not on the fill
call.

Before inventing any hex value, read the file's design tokens — see the
`figma-tokens` skill. Colours picked out of the air are the single fastest way
to produce something that has to be redone.

## Verify what you built

Finish with `get_screenshot` on the root frame's id and **look at the image**.
The call order can succeed while the result is visibly broken: overlapping
text, a frame that hugged to zero height, a colour that vanished against the
background. If the screenshot shows something wrong, fix it before reporting.

Then report the `fileKey`, the name and id of the root frame, and what you
changed. The person needs to be able to find your work in the file.

## Destructive calls

`delete_nodes`, `ungroup_node` and `remove_*` are irreversible from the
office's side and will ask the user for confirmation. Prefer building alongside
and letting the person delete the old version. If a rebuild genuinely requires
deleting, say what you are about to delete and why before you call it.
