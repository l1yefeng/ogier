/**
 * Used by anyone.
 */

export const APP_NAME = "Ogier EPUB Reader";

export interface SpineItemData {
	// Start from 0, indexing the spine
	position: number;
	// Path relative to the archive root. No leading "/" or "epub://", or tailing "/"
	path: string;
	// File content
	text: string;
}

export enum CustomStyleKey {
	BaseFontSize = "base-font-size",
	LineHeightScale = "line-height-scale",
	InlineMargin = "inline-margin",
}
export type CustomStyles = Record<CustomStyleKey, number>;

export interface EpubNavPoint {
	label: string;
	content: string;
	playOrder: number;
	children: EpubNavPoint[];
}

export type EpubToc =
	| {
			kind: "nav";
			path: string;
			nav: HTMLElement;
			lang: string;
	  }
	| {
			kind: "ncx";
			root: EpubNavPoint;
			lang: string;
	  };

export type EpubMetadata = Record<string, string[]>;

export interface EpubFileInfo {
	path: string;
	size: number;
	created: number;
	modified: number;
}

export interface EpubDetails {
	fileInfo: EpubFileInfo;
	metadata: EpubMetadata;
	spineLength: number;
	displayTitle: string;
	coverBase64: string;
}

/**
 * Checks if `locationId` matches `elem` or nearby elements.
 *
 * @param locationId - The ID (without hash) to check.
 * @param elem - The DOM element to compare.
 * @returns `true` if `locationId` matches `elem` or a surrounding element.
 */
export function isLocationNear(locationId: string, elem: Element): boolean {
	if (elem.id == locationId) {
		return true;
	}
	for (const child of elem.children) {
		if (child.id == locationId) {
			return true;
		}
	}
	if (elem.parentElement?.id == locationId) {
		return true;
	}
	if (elem.previousElementSibling?.id == locationId) {
		return true;
	}
	if (elem.nextElementSibling?.id == locationId) {
		return true;
	}
	return false;
}

/**
 * @requires href value starts with epub://. This is ensured by rs.
 */
export function repairEpubHref(anchor: HTMLAnchorElement, currentPath: string): void {
	const value = anchor.getAttribute("href");
	if (!value) {
		return;
	}
	const hashIndex = value.lastIndexOf("#");
	if (hashIndex <= 0) {
		return;
	}
	if (value[hashIndex - 1] == "/") {
		anchor.href = value.substring(hashIndex);
	} else if (value.substring(7, hashIndex) == currentPath) {
		anchor.href = value.substring(hashIndex);
	}
}

export function anchoredSamePageLocation(elem: HTMLAnchorElement): string | null {
	const href = elem.getAttribute("href");
	if (href && href.startsWith("#")) {
		return href.substring(1);
	}
	return null;
}

const SESSION_CONTINUE_KEY = "reading";

export function markSessionInProgress(): void {
	sessionStorage.setItem(SESSION_CONTINUE_KEY, "yes");
}

export function takeSessionInProgress(): boolean {
	const yes = !!sessionStorage.getItem(SESSION_CONTINUE_KEY);
	sessionStorage.removeItem(SESSION_CONTINUE_KEY);
	return yes;
}

export function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

export type FontPrefer = "sans-serif" | "serif" | null;

export function getCurrentPosition(box: DOMRect, content: DOMRect): number {
	return getCurrentPositionPx(box, content) / content.height;
}

export function getCurrentPositionPx(box: DOMRect, content: DOMRect): number {
	return box.height / 5 - content.top;
}

export function getCurrentPositionInverse(
	box: DOMRect,
	content: DOMRect,
	percentage: number,
): number {
	const top = percentage * content.height;
	return top - box.height / 5;
}

export class TaskRepeater {
	#intervalMs: number;
	#handle: number | null = null;

	constructor(intervalMs: number) {
		this.#intervalMs = intervalMs;
	}

	restart(f: () => void): void {
		if (this.#handle != null) {
			window.clearInterval(this.#handle);
		}
		f();
		this.#handle = window.setInterval(f, this.#intervalMs);
	}
}
