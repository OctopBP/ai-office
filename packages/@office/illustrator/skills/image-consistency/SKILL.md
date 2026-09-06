---
name: image-consistency
description: Keep a series of generated pictures in one style — icon sets, sprite sets, card illustrations, a set of covers, several pictures for one page. Use whenever more than one image has to look like it belongs with the others, or a new picture must match pictures that already exist in the repository. Covers style anchors, prompt reuse, generation order and how to check a set.
---

# Keeping a set in one style

Image models have no memory between requests and no seed. Two calls with the
same prompt give two different pictures. So a consistent set is not something
you ask for — it is something you construct, and there are only three levers.

## Lever 1: a style anchor

Generate **one** picture first, spend real effort on it, and treat it as the
reference for everything else. Everything after it is drawn with the anchor
attached as a source image (`ref_urls` / `ref_paths`, whichever the provider
takes) plus a prompt that changes only the subject.

Without an anchor a set drifts: the third icon has a thicker outline than the
first, the fifth is lit from the other side, and by the tenth nothing matches.

This project already works this way for its sprites —
`tools/props/refs/style_ref.png` is the anchor for the whole prop pipeline, and
`tools/props/README.md` calls it the main lever of consistency. If the task is
about office sprites, use that pipeline, not a fresh style of your own.

If the provider cannot take source images at all, the anchor has to live in the
prompt instead: freeze one exact style sentence and repeat it verbatim in every
request. Verbatim — not paraphrased. A reworded style clause is a new style.

## Lever 2: one prompt skeleton

Write the prompt as a template with one hole:

```
<STYLE BLOCK — identical in every request, copied not retyped>
<PALETTE BLOCK — identical>
Subject: <the only thing that changes>
<NEGATIVES — identical: no text, no watermark, no border>
```

Keep the skeleton in a file next to the pictures (`prompts.txt`, or a `.txt`
per image as `image-generate` requires). The next person to extend the set —
possibly you, in another task — cannot recover it from the pictures.

## Lever 3: order of work

1. Draw the anchor. Look at it with `Read`. Redraw it until it is right.
2. Only then draw the rest, **in small batches**, checking after each batch.
3. If a batch drifts, fix the skeleton — do not fix pictures one by one.

Drawing ten pictures before looking at any of them is the expensive mistake
this skill exists to prevent: ten wrong pictures cost ten generations and are
thrown away together.

## Matching pictures that already exist

When the set already has members in the repository, the existing files are the
anchor. Open two or three with `Read` first and name what you see in the
prompt: outline weight, perspective (flat / isometric / three-quarter), light
direction, level of detail, palette, whether shapes are rounded or hard.
Adjectives you did not name are the ones that will drift.

## Checking a set

Look at the set together, not picture by picture: build a contact sheet with
the shell (the project has `tools/props/board.mjs` for exactly this) or open
them one after another. Check in this order — silhouette, outline weight,
perspective, palette, level of detail. A single picture that fails any of these
is a redraw; three that fail the same way mean the skeleton is wrong.
