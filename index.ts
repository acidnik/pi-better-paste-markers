/**
 * pi-better-paste-markers — richer collapsed paste markers for pi.
 *
 * Large pastes (>10 lines or >1000 chars) collapse into a bare
 * `[paste #N 1234 chars]` marker that gives no feedback about what was actually
 * pasted (easy to mix up clipboards). This extension replaces the main editor
 * with one that renders the marker as a three-line block:
 *
 *     [first line of the pasted text, truncated...
 *      paste #1 1623 chars / 42 lines
 *      ...last line of the pasted text, truncated from the left]
 *
 * The buffer keeps the block as ordinary editable lines, and the canonical
 * single-line marker lives on the middle line. On submit (`getExpandedText()`)
 * the whole block is replaced with the original paste content; everywhere else
 * (`getText()`) it collapses back to the canonical marker, so drafts,
 * autocomplete snapshots and undo all see the standard form.
 *
 * Delete keys are intercepted so the three lines behave as one unit: a single
 * backspace/delete that touches a block removes the whole block, like the
 * built-in `[paste #N ...]` marker.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/** The middle line of a paste block (our own format, ids from our own counter). */
const MIDDLE_RE = /^paste #(\d+) (\d+) chars \/ (\d+) lines$/;
/** Max characters shown for the first/last preview line before truncation. */
const PREVIEW_MAX_CHARS = 80;
/** Gray `❯` prompt drawn before the input line (matches pi-powerline-footer chrome). */
const INPUT_PROMPT = "\x1b[38;2;200;200;200m❯\x1b[0m";

interface PasteRecord {
	content: string;
	lines: number;
	chars: number;
	/** First-line preview; carries a trailing `...` when truncated. */
	first: string;
	/** Last-line preview; carries a leading `...` when truncated. */
	last: string;
}

/** Where a rendered three-line paste block lives in the editor buffer. */
interface PasteBlock {
	/** Logical line holding the leading `[first line...` preview. */
	startLine: number;
	/** Logical line holding the trailing `...last line]` preview. */
	endLine: number;
	/** Column in `startLine` where the block's opening `[` sits. */
	startCol: number;
	/** Column in `endLine` just past the block's closing `]`. */
	endCol: number;
	/** Paste id carried by the block's middle line. */
	id: number;
	/** The paste this block stands for. */
	record: PasteRecord;
}

/** Which side of the block a deletion key bites from. */
type DeleteDirection = "backward" | "forward" | "line";

export default function betterPasteMarkers(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new BetterPasteEditor(tui, theme, keybindings),
		);
	});
}

export class BetterPasteEditor extends CustomEditor {
	/** id -> record; ids come from our own counter, so they never collide. */
	private pasteRecords = new Map<number, PasteRecord>();
	private ownPasteCounter = 0;
	private editorKeybindings: KeybindingsManager;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.editorKeybindings = keybindings;
	}

	/**
	 * Delete keys hit our three-line blocks as one unit: any deletion that would
	 * bite into a block removes the whole block, matching the built-in
	 * single-line `[paste #N ...]` marker behavior.
	 */
	override handleInput(data: string): void {
		if (this.tryDeleteBlock(data)) return;
		super.handleInput(data);
	}

	private tryDeleteBlock(data: string): boolean {
		if (this.pasteRecords.size === 0 || this.isShowingAutocomplete()) return false;

		const kb = this.editorKeybindings;
		let direction: DeleteDirection | null = null;
		if (
			kb.matches(data, "tui.editor.deleteCharBackward") ||
			kb.matches(data, "tui.editor.deleteWordBackward") ||
			matchesKey(data, "shift+backspace")
		) {
			direction = "backward";
		} else if (
			kb.matches(data, "tui.editor.deleteCharForward") ||
			kb.matches(data, "tui.editor.deleteWordForward") ||
			matchesKey(data, "shift+delete")
		) {
			direction = "forward";
		} else if (
			kb.matches(data, "tui.editor.deleteToLineStart") ||
			kb.matches(data, "tui.editor.deleteToLineEnd")
		) {
			// Ctrl+U / Ctrl+K can shear a block apart in the middle of a line,
			// so treat any block line as a hit for these.
			direction = "line";
		}
		if (!direction) return false;

		const block = this.findBlocks().find((candidate) => this.cursorHitsBlock(candidate, direction!));
		if (!block) return false;

		this.deleteBlock(block);
		return true;
	}

	/** Find every intact three-line block in `lines` (defaults to the buffer). */
	private findBlocks(lines: string[] = this.state.lines): PasteBlock[] {
		const blocks: PasteBlock[] = [];
		for (let i = 0; i + 2 < lines.length; i++) {
			const middle = MIDDLE_RE.exec(lines[i + 1] ?? "");
			if (!middle) continue;
			const id = Number(middle[1]);
			const record = this.pasteRecords.get(id);
			if (!record) continue;
			const opening = `[${record.first}`;
			const closing = `${record.last}]`;
			const firstLine = lines[i] ?? "";
			const lastLine = lines[i + 2] ?? "";
			if (!firstLine.endsWith(opening) || !lastLine.startsWith(closing)) continue;
			blocks.push({
				startLine: i,
				endLine: i + 2,
				startCol: firstLine.length - opening.length,
				endCol: closing.length,
				id,
				record,
			});
			i += 2; // the next block cannot overlap this one
		}
		return blocks;
	}

	/** Does a deletion in `direction` reach into this block? */
	private cursorHitsBlock(block: PasteBlock, direction: DeleteDirection): boolean {
		const line = this.state.cursorLine;
		const col = this.state.cursorCol;
		if (line < block.startLine || line > block.endLine) return false;
		if (direction === "line") return true;

		const firstLineLength = (this.state.lines[block.startLine] ?? "").length;
		if (line === block.startLine) {
			return direction === "backward"
				? col > block.startCol && col <= firstLineLength
				: col >= block.startCol && col <= firstLineLength;
		}
		if (line === block.endLine) {
			return direction === "backward" ? col <= block.endCol : col < block.endCol;
		}
		return true; // middle line is entirely inside the block
	}

	/** Remove all block lines, keeping the text before and after on one line. */
	private deleteBlock(block: PasteBlock): void {
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.exitHistoryBrowsing();

		const lines = this.state.lines;
		const before = (lines[block.startLine] ?? "").slice(0, block.startCol);
		const after = (lines[block.endLine] ?? "").slice(block.endCol);
		lines[block.startLine] = before + after;
		lines.splice(block.startLine + 1, block.endLine - block.startLine);

		// Keep the paste record: undo restores the block lines, and the record is
		// what lets collapse()/expand() recognize them again afterwards.
		this.state.cursorLine = block.startLine;
		this.state.cursorCol = before.length;
		if (this.onChange) this.onChange(this.getText());
	}

	override handlePaste(pastedText: string): void {
		const filteredText = this.cleanPastedText(pastedText);
		const pastedLines = filteredText.split("\n");

		// Small pastes keep the base behavior (inserted as-is, no marker).
		if (pastedLines.length <= 10 && filteredText.length <= 1000) {
			super.handlePaste(pastedText);
			return;
		}

		this.cancelAutocomplete();
		this.exitHistoryBrowsing();
		this.lastAction = null;
		this.pushUndoSnapshot();

		const id = ++this.ownPasteCounter;
		this.pasteRecords.set(id, {
			content: filteredText,
			lines: pastedLines.length,
			chars: filteredText.length,
			first: previewHead(pastedLines[0] ?? ""),
			last: previewTail(pastedLines[pastedLines.length - 1] ?? ""),
		});

		const record = this.pasteRecords.get(id)!;
		const block = [
			`[${record.first}`,
			`paste #${id} ${filteredText.length} chars / ${pastedLines.length} lines`,
			`${record.last}]`,
		];
		this.insertTextAtCursorInternal(block.join("\n"));
	}

	/**
	 * Base cleanup for pasted text: decode tmux CSI-u re-encoding of control
	 * bytes inside bracketed paste, normalize line endings/tabs, drop
	 * non-printables (keep newlines), and keep the "paste a path mid-word"
	 * space-prepending quirk.
	 */
	private cleanPastedText(pastedText: string): string {
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match: string, code: string) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});
		const cleanText = this.normalizeText(decodedText);
		let filteredText = cleanText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");
		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}
		return filteredText;
	}

	/** Collapse every intact 3-line block back to its canonical single-line marker. */
	private collapse(text: string): string {
		if (this.pasteRecords.size === 0) return text;
		const lines = text.split("\n");
		const blocks = this.findBlocks(lines);
		if (blocks.length === 0) return text;
		// Rewrite from the bottom up so earlier line indexes stay valid.
		for (let b = blocks.length - 1; b >= 0; b--) {
			const block = blocks[b]!;
			const prefix = (lines[block.startLine] ?? "").slice(0, block.startCol);
			const suffix = (lines[block.endLine] ?? "").slice(block.endCol);
			// Canonical single-line marker (base format), so downstream code and
			// older sessions see the usual form.
			const canonical =
				block.record.lines > 10
					? `[paste #${block.id} +${block.record.lines} lines]`
					: `[paste #${block.id} ${block.record.chars} chars]`;
			lines.splice(block.startLine, block.endLine - block.startLine + 1, prefix + canonical + suffix);
		}
		return lines.join("\n");
	}

	/** Replace collapsed canonical markers with their original content. */
	private expand(text: string): string {
		let result = text;
		for (const [id, rec] of this.pasteRecords) {
			result = result
				.split(`[paste #${id} ${rec.chars} chars]`)
				.join(rec.content)
				.split(`[paste #${id} +${rec.lines} lines]`)
				.join(rec.content);
		}
		return result;
	}

	override getText(): string {
		return this.collapse(super.getText());
	}

	override getLines(): string[] {
		return this.collapse(super.getText()).split("\n");
	}

	override getExpandedText(): string {
		return this.expand(this.collapse(super.getText()));
	}

	/**
	 * Plain Enter submits through the base editor's private `submitValue()`,
	 * which expands paste markers with this method — not with
	 * `getExpandedText()`. Shadowing it keeps our blocks from being submitted
	 * as raw three-line preview text (the base registry never holds them).
	 */
	override expandPasteMarkers(text: string): string {
		return this.expand(this.collapse(super.expandPasteMarkers(text)));
	}

	/**
	 * Draw a `❯` prompt before the input, mirroring the chrome that
	 * pi-powerline-footer applies to the default editor. Replacing the editor
	 * component drops that wrapper, so we render the prompt ourselves.
	 */
	override render(width: number): string[] {
		if (width < 10) return super.render(width);

		const contentWidth = Math.max(1, width - 3);
		const lines = super.render(contentWidth);
		if (lines.length === 0) return lines;

		// The bottom border is the last `───…` row before any autocomplete rows.
		let bottomBorderIndex = lines.length - 1;
		for (let i = lines.length - 1; i >= 1; i--) {
			const stripped = (lines[i] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
			if (stripped.length > 0 && /^─{3,}/.test(stripped)) {
				bottomBorderIndex = i;
				break;
			}
		}

		const promptPrefix = ` ${INPUT_PROMPT} `;
		const contPrefix = "   ";
		const border = " " + this.borderColor("─".repeat(Math.max(0, width - 2)));
		const result: string[] = [border];
		for (let i = 1; i < bottomBorderIndex; i++) {
			result.push(`${i === 1 ? promptPrefix : contPrefix}${lines[i] ?? ""}`);
		}
		if (bottomBorderIndex === 1) {
			result.push(`${promptPrefix}${" ".repeat(contentWidth)}`);
		}
		result.push(border);
		for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
			result.push(lines[i] ?? "");
		}
		return result;
	}
}

/** First-line preview: keep the head, add `...` only when something was cut. */
function previewHead(text: string): string {
	return text.length <= PREVIEW_MAX_CHARS ? text : `${text.slice(0, PREVIEW_MAX_CHARS - 3)}...`;
}

/** Last-line preview: keep the tail, add `...` only when something was cut. */
function previewTail(text: string): string {
	return text.length <= PREVIEW_MAX_CHARS ? text : `...${text.slice(text.length - (PREVIEW_MAX_CHARS - 3))}`;
}
