/**
 * Used by anyone.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

export const APP_NAME = "OgierEPUB";

export interface AboutPubJson {
	// file
	filePath: string;
	fileSize: number;
	fileCreated: number;
	fileModified: number;
	// epub
	pubMetadata: EpubMetadata;
	pubSpine: string[];
	pubCoverUrl: string | null;
	pubTocUrl: string | null;
	pubTocIsLegacy: boolean;
	pubLandingPage: string;
}
export interface AboutPub {
	// file
	filePath: string;
	fileSize: number;
	fileCreated: Date | null;
	fileModified: Date | null;
	// epub
	pubMetadata: EpubMetadata;
	pubSpine: URL[];
	pubCoverUrl: URL | null;
	pubTocUrl: URL | null;
	pubTocIsLegacy: boolean;
	pubLandingPage: URL;
}

export function aboutPubFromJson(json: AboutPubJson): AboutPub {
	const {
		filePath,
		fileSize,
		fileCreated,
		fileModified,
		pubMetadata,
		pubSpine,
		pubCoverUrl,
		pubTocUrl,
		pubTocIsLegacy,
		pubLandingPage,
	} = json;

	const dateFromMs = (ms: number) => {
		if (ms == 0) return null;
		const date = new Date();
		date.setTime(ms);
		return date;
	};

	return {
		filePath,
		fileSize,
		fileCreated: dateFromMs(fileCreated),
		fileModified: dateFromMs(fileModified),
		pubMetadata,
		pubSpine: pubSpine.map(s => URL.parse(s)!),
		pubCoverUrl: pubCoverUrl == null ? null : URL.parse(pubCoverUrl)!,
		pubTocUrl: pubTocUrl == null ? null : URL.parse(pubTocUrl)!,
		pubTocIsLegacy,
		pubLandingPage: URL.parse(pubLandingPage)!,
	};
}

export enum FilewiseStylesKey {
	BaseFontSize = "base-font-size",
	LineHeightScale = "line-height-scale",
	InlineMargin = "inline-margin",
}
export type FilewiseStyles = Record<FilewiseStylesKey, number>;

interface EpubExprBase {
	property: string;
	value: string;
	lang?: string;
}
export interface EpubMetadataRefinement extends EpubExprBase {
	scheme?: string;
}
export interface EpubMetadataItem extends EpubExprBase {
	refined: EpubMetadataRefinement[];
}
export type EpubMetadata = EpubMetadataItem[];

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

function toResourceUri(uri: URL): string {
	// NOTE: convertFileSrc(s, scheme) is
	//  PLATFORM_SPECIFIC_PREFIX + encodeURIComponent(s)
	// which means '/' in s will be escaped and the path structured is broken.
	// So "" is used to make use of the platform-specific part,
	// and append the pathname manually.
	let tauriUrl = convertFileSrc("", "epub");
	tauriUrl += uri.pathname.slice(1);
	return tauriUrl;
}

export function setElementUrl(
	element: HTMLAnchorElement | HTMLImageElement | SVGImageElement | HTMLLinkElement,
	url: URL,
): void {
	const tauriUrl = toResourceUri(url);
	if (element instanceof HTMLAnchorElement) {
		element.href = tauriUrl;
	} else if (element instanceof HTMLImageElement) {
		element.src = tauriUrl;
	} else if (element instanceof SVGImageElement) {
		element.href.baseVal = tauriUrl;
	} else if (element instanceof HTMLLinkElement) {
		element.href = tauriUrl;
	}
}

export function fetchXml(url: URL, isContentDoc: boolean): Promise<Document> {
	const tauriUrl = toResourceUri(url);
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("GET", tauriUrl);
		if (isContentDoc) {
			xhr.setRequestHeader("Accept", "application/xhtml+xml");
			xhr.setRequestHeader("Accept", "image/svg+xml");
			xhr.setRequestHeader("Ogier-Epub-Content-Document", "1");
		}
		xhr.onerror = reject;
		xhr.onload = () => {
			// TODO: confirm svg works
			const doc = xhr.responseXML;
			if (doc == null) {
				throw new Error("null XML in response");
			}
			resolve(doc);
		};
		xhr.send();
	});
}
