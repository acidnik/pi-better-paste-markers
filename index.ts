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
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** The middle line of a paste block (our own format, ids from our own counter). */
const MIDDLE_RE = /^paste #(\d+) (\d+) chars \/ (\d+) lines$/;
/** Fallback preview width when the terminal width is unknown. */
const PREVIEW_FALLBACK_WIDTH = 72;

interface PasteRecord {
	content: string;
	lines: number;
	chars: number;
	first: string;
	last: string;
}

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
		const width = (process.stdout.columns ?? 80) - 4;
		this.pasteRecords.set(id, {
			content: filteredText,
			lines: pastedLines.length,
			chars: filteredText.length,
			first: truncateToWidth(pastedLines[0] ?? "", Math.max(width, 20)),
			last: truncateLastLine(pastedLines[pastedLines.length - 1] ?? "", Math.max(width, 20)),
		});

		const block = [
			`[${this.pasteRecords.get(id)!.first}...`,
			`paste #${id} ${filteredText.length} chars / ${pastedLines.length} lines`,
			`...${this.pasteRecords.get(id)!.last}]`,
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
		const out: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const m = MIDDLE_RE.exec(lines[i]);
			if (!m || !this.pasteRecords.has(Number(m[1]))) {
				out.push(lines[i]);
				continue;
			}
			const id = Number(m[1]);
			const rec = this.pasteRecords.get(id)!;
			const prev = out[out.length - 1];
			if (prev !== undefined && prev.startsWith("[") && prev.endsWith("...")) {
				out.pop(); // decorated first-line preview
			}
			const next = lines[i + 1];
			if (next !== undefined && next.startsWith("...") && next.endsWith("]")) {
				i++; // skip the decorated last-line preview
			}
			// Canonical single-line marker (base format), so downstream code and
			// older sessions see the usual form.
			out.push(rec.lines > 10 ? `[paste #${id} +${rec.lines} lines]` : `[paste #${id} ${rec.chars} chars]`);
		}
		return out.join("\n");
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
}

/** Truncate from the right, keeping the tail visible on the last-line preview. */
function truncateLastLine(text: string, width: number): string {
	if (text.length <= width) return text;
	return text.slice(text.length - width + 3);
}
