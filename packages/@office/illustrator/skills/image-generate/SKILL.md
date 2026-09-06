---
name: image-generate
description: Draw a picture through the imagegen MCP server — illustration, cover, icon, texture, background, concept art. Use whenever the task is to produce an image file rather than describe one — "нарисуй", "сгенерируй картинку", "нужна иллюстрация/обложка/иконка", "сделай текстуру". Covers the call order, what to put in a prompt, aspect ratio versus pixel size, editing an existing picture, and what to check before reporting done.
---

# Drawing with imagegen

The `mcp__imagegen__*` tools call an image API and save the result as a file in
your working copy. Three tools, and the split matters:

- `get_image_providers` — what is connected, with which key, which aspect
  ratios, how many variants per request, and whether the provider takes source
  images by link or by file.
- `generate_image` — draw and save. Waits for the picture inside the call.
- `get_image_task` — pick up a task that did not finish in time.

## Order of work

1. **`get_image_providers` first, once per task.** It tells you which provider
   has a key and what it can do. Guessing an aspect ratio the provider does not
   know costs a rejected request.
2. **Find out where the picture goes.** Read the code or the docs that will use
   it: pixel size, aspect ratio, background, and what it sits next to. A cover
   for a README and an icon for a button are not the same job.
3. **Write the prompt** (see below), then `generate_image` with an explicit
   `path` inside the working copy.
4. **Look at the result with `Read`** — it opens images. This is not optional:
   image models routinely produce the wrong count of fingers, the wrong text,
   the wrong crop.
5. **Save the prompt next to the picture** as a `.txt` with the same base name:
   prompt, provider, aspect ratio. There is no seed. If the prompt is lost, the
   picture cannot be reproduced or nudged — it can only be redrawn from zero.
6. Report the paths you saved and what each picture is for.

## Writing the prompt

Image models follow nouns and adjectives, not intentions. State, in this order:

- **subject** — what is in the frame, and nothing else in it;
- **composition** — close-up / full body / wide shot, where the subject sits,
  what is behind it;
- **style** — flat vector, pixel art, watercolour, 3D render, photo; name a
  technique, not a feeling;
- **palette** — actual colours or a named scheme, especially if the picture
  must sit next to existing UI;
- **background** — solid colour, gradient, transparent-looking, or a scene.

Two rules that save whole rounds:

- **Say what must NOT be there.** "no text", "no watermark", "no border" are
  worth more than three adjectives — models add text and frames on their own,
  and text they add is almost always misspelled.
- **Do not ask for readable words in the picture.** If the picture needs a
  caption, generate it without text and put the text on top in code or in the
  layout.

## Aspect ratio is not pixel size

`aspect` picks the shape of the frame, not the resolution — the provider
returns whatever size it returns. If the target needs exact pixels, pick the
nearest aspect ratio, then resize with the shell after saving, and check what
you actually got before reporting.

Transparency is a separate trap: these models do not draw an alpha channel.
For a picture that must sit on an arbitrary background, generate it on a flat
key colour that does not occur in the subject (magenta `#FF00FF`, or green for
pink subjects), then cut the background out afterwards. This project already
does exactly that for sprites — see `tools/props/lib/image.mjs`.

## Editing an existing picture

Editing means passing sources along with the prompt, and providers differ:

- `refs: url` — sources go in `ref_urls`, and they must be links the provider
  can fetch. A local file cannot be attached; upload it somewhere first or use
  a different provider.
- `refs: file` — sources go in `ref_paths`, local paths.

Passing the wrong kind is refused before the request is paid for, so read
`get_image_providers` instead of guessing.

## "Still drawing" is not a failure

If the answer carries a `task_id`, the picture is being drawn and has already
been paid for. Call `get_image_task` with that id and the same `path`. Calling
`generate_image` again starts a second, separate, billed generation.

## Cost

Every request spends credits from a key that is not yours. Two variants of a
well-aimed prompt beat six of a vague one. When a result is wrong, change the
prompt before drawing again — redrawing the same prompt gives a different
picture with the same problem.

If a provider answers that there is no key, that is for a human to fix. Say
which variable is missing and stop; do not download someone else's picture
instead — their licence is not yours to pass on.
