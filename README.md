# pi-better-paste-markers

Richer collapsed paste markers for [pi](https://github.com/earendil-works/pi).

Large pastes collapse into a bare `[paste #1 1623 chars]` marker with no feedback about what was actually pasted — easy to mix up clipboards (Linux primary/secondary). This replaces the marker with a three-line preview block. Pure extension: no core changes. Follow-up to [earendil-works/pi#10216](https://github.com/earendil-works/pi/issues/10216).

## What it does

Pastes over 10 lines or 1000 chars render as a three-line block:

```
[first line of the pasted text, truncated...
 paste #1 1623 chars / 42 lines
 ...last line of the pasted text, truncated from the left]
```

- Small pastes keep the built-in behavior (inserted as-is, no marker).
- The block is ordinary editable buffer lines; the middle line carries the marker.
- On submit the block is replaced with the original pasted content — nothing is lost.
- Everywhere else (drafts, autocomplete, undo) the block collapses back to the standard single-line `[paste #N ...]` marker.
- Editing/deleting the middle line of a block drops that paste on submit — same as deleting a built-in paste marker.

## Install

```
pi install git:github.com/acidnik/pi-better-paste-markers
```

## How it works

The extension replaces the main editor on `session_start` via `ctx.ui.setEditorComponent()` with a `CustomEditor` subclass:

- `handlePaste()` — small pastes delegate to the base; large pastes insert the 3-line block and keep the content in an extension-side map.
- `getText()` — collapses blocks back to canonical `[paste #N ...]` markers (drafts, autocomplete snapshots, undo).
- `getExpandedText()` — submits the original pasted content (used by pi on submit and by the external-editor flow).
