import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
	end_of_spine_message,
	toc_default_title,
	toc_unavailable_message,
} from "./strings.json";

import {
	anchoredSamePageLocation,
	CustomStyles,
	EpubDetails,
	EpubToc,
	FontPrefer,
	getCurrentPosition,
	getCurrentPositionInverse,
	getCurrentPositionPx,
	isLocationNear,
	markSessionInProgress,
	SpineItemData,
	TaskRepeater,
	toResourceUri,
} from "./base";
import { Context } from "./context";
import {
	activateCustomizationInput,
	commitCustomStylesFromSaved,
	eventTargetIsCustomizationInput,
	loadCustomizationContent,
} from "./custom";
import * as rs from "./invoke";
import { DetailsModal, NavModal, PreviewModal } from "./modal";
import { Styler } from "./styler";

// Elements. Initialized in DOMContentLoaded listener.
//

let elemFrame: HTMLElement | null;
let elemReaderHost: HTMLElement | null;
let elemTocButton: HTMLButtonElement | null;
let elemTocBtnLabel: HTMLElement | null;
let elemSpinePosition: HTMLElement | null;

// Other global variables. Lazily initialized.
//

// See initReaderFrame() for initilization
let readerShadowRoot: ShadowRoot | null = null;
let styler: Styler | null = null;
const refreshTocBtnLabelTask = new TaskRepeater(500);
const saveReadingProgressTask = new TaskRepeater(2000);

export function loadContent(): void {
	elemFrame = document.getElementById("og-frame") as HTMLDivElement;
	elemReaderHost = document.getElementById("og-reader-host") as HTMLDivElement;
	elemTocButton = document.getElementById("og-toc-button") as HTMLButtonElement;
	elemTocBtnLabel = document.getElementById("og-toc-button-label") as HTMLElement;
	elemSpinePosition = document.getElementById("og-spine-position") as HTMLElement;
	loadCustomizationContent();
}

function loadImageElement(
	elem: HTMLImageElement | SVGImageElement,
	url: URL,
	useUri: (uri: string) => void,
): void {
	// TODO: debugging, and meanwhile maybe we use `register_asynchronous_uri_scheme_protocol`
	console.debug(`ENTER: loadImageElement(${url})`);
	useUri(toResourceUri(url));
}

/**
 * Call this at some point during the loading of a page (Docuemnt).
 *
 * @param head `<head>` element of the page the reader is loading.
 */
async function loadPageStyles(
	head: HTMLHeadElement,
	currentDocUrl: URL,
): Promise<HTMLLinkElement[]> {
	// const linkedUrls: URL[] = [];
	const stylesheetLinks: HTMLLinkElement[] = [];
	for (const elemLink of head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
		const uri = URL.parse(elemLink.getAttribute("href") ?? "", currentDocUrl);
		if (uri) {
			elemLink.href = toResourceUri(uri);
			stylesheetLinks.push(elemLink);
			// linkedUrls.push(url);
			// elemLink.remove();
		}
	}
	// await styler!.load(linkedUrls);

	let cssInPage = "";
	for (const elemStyle of head.querySelectorAll<HTMLStyleElement>("style")) {
		const css = elemStyle.textContent;
		if (css) {
			cssInPage += css;
		}
	}
	styler!.setStyleElemsCss(cssInPage);

	// TODO(opt) can be parallel?
	await styler!.loadAppPrefs();
	return stylesheetLinks;
}

async function renderBookPage(
	spineItem: SpineItemData,
	percentage: number | null,
): Promise<void> {
	console.debug("ENTER: renderBookPage");
	// Remove everything first
	readerShadowRoot!.replaceChildren();

	console.debug("parsing doc");
	const parser = new DOMParser();
	const pageDoc = parser.parseFromString(spineItem.text, spineItem.mimetype);
	Context.spineItemLang = pageDoc.documentElement.lang;
	elemReaderHost!.lang = Context.spineItemLang || Context.epubLang;
	const pageBody = pageDoc.body;

	// load all images: <img> and svg <image>
	for (const elem of pageBody.querySelectorAll<HTMLImageElement>("img")) {
		const url = URL.parse(elem.src, spineItem.path);
		if (url) {
			loadImageElement(elem, url, uri => {
				elem.src = uri;
			});
		}
	}
	for (const elem of pageBody.querySelectorAll<SVGImageElement>("image")) {
		const url = URL.parse(elem.href.baseVal, spineItem.path);
		if (url) {
			loadImageElement(elem, url, uri => {
				elem.href.baseVal = uri;
			});
		}
	}

	// // repair anchor element hrefs
	// new Promise(() => {
	// 	for (const elem of pageBody.querySelectorAll<HTMLAnchorElement>('a[href^="epub://"]')) {
	// 		repairEpubHref(elem, spineItem.path);
	// 	}
	// });

	console.debug("CALL: loadPageStyles (skipped)");
	const stylesheetLinks = await loadPageStyles(pageDoc.head, spineItem.path);

	let customStyles: Partial<CustomStyles>;
	try {
		customStyles = (await rs.getCustomStyles()) || {};
	} catch (err) {
		console.error("Error loading saved custom styles:", err);
		customStyles = {};
	}
	const localStylesCommit = (styles: CustomStyles) => (styler!.filewiseStyles = styles);
	commitCustomStylesFromSaved(customStyles, localStylesCommit);
	activateCustomizationInput(localStylesCommit, rs.setCustomStyles);

	// insert the body
	readerShadowRoot!.append(...stylesheetLinks, pageBody);
	if (percentage != null) {
		const top = getCurrentPositionInverse(
			elemReaderHost!.getBoundingClientRect(),
			pageBody.getBoundingClientRect(),
			percentage,
		);
		elemReaderHost!.scroll({ top, behavior: "instant" });
	}

	elemSpinePosition!.textContent = `Position: ${spineItem.position} / ${Context.spineLength!}`;

	refreshTocBtnLabelTask.restart(() => {
		const hostRect = elemReaderHost!.getBoundingClientRect();
		const bodyRect = pageBody.getBoundingClientRect();
		const btn = NavModal.get().mostRecentNavPoint(
			spineItem.path.pathname,
			getCurrentPositionPx(hostRect, bodyRect),
			id => {
				const target = readerShadowRoot!.getElementById(id);
				if (!target) {
					return 0;
				}
				return target.getBoundingClientRect().top - bodyRect.top;
			},
		);
		if (btn) {
			elemTocBtnLabel!.lang = btn.closest<HTMLElement>("[lang]")?.lang!;
			elemTocBtnLabel!.textContent = btn.textContent;
		} else {
			elemTocBtnLabel!.removeAttribute("lang");
			elemTocBtnLabel!.textContent = toc_default_title;
		}
	});
	saveReadingProgressTask.restart(() => {
		const hostRect = elemReaderHost!.getBoundingClientRect();
		const bodyRect = pageBody.getBoundingClientRect();
		rs.setReadingPosition(getCurrentPosition(hostRect, bodyRect));
	});

	markSessionInProgress();
}

function findPreviewContent(elemLocation: HTMLElement): HTMLElement {
	// First, try to locate a <li>, and use its content
	let elemLi: HTMLLIElement | null = null;
	if (elemLocation instanceof HTMLLIElement) {
		elemLi = elemLocation;
	} else if (elemLocation.parentElement instanceof HTMLLIElement) {
		elemLi = elemLocation.parentElement;
	}
	if (elemLi) {
		return elemLi;
	}

	// Next, use its parent if it's a <a>
	if (elemLocation instanceof HTMLAnchorElement) {
		const parent = elemLocation.parentElement;
		if (parent) {
			return parent;
		}
	}

	return elemLocation;
}

function createSamePageLocationPreviewContent(
	anchor: HTMLElement,
	elemLocation: HTMLElement,
): [HTMLElement, HTMLElement] | null {
	const elemToPreview = findPreviewContent(elemLocation);
	const clone = elemToPreview.cloneNode(true) as HTMLElement;
	for (const elem of clone.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
		const idPointedByElem = anchoredSamePageLocation(elem)!;
		if (isLocationNear(idPointedByElem, anchor)) {
			const subs = document.createElement("span");
			subs.classList.add("og-note-icon");
			elem.replaceWith(subs);
		} else {
			elem.href = "";
		}
	}

	if (!clone.textContent?.trim()) {
		return null;
	}

	return [clone, elemToPreview];
}

function previewSamePageLocation(anchor: HTMLElement, elemNoteId: string): void {
	const elemNote = readerShadowRoot!.getElementById(elemNoteId);
	if (!elemNote) {
		return;
	}
	const result = createSamePageLocationPreviewContent(anchor, elemNote);
	if (result) {
		const [clone, original] = result;
		const modal = PreviewModal.get();
		modal.show(clone);
		modal.setupGoThere(() => {
			elemNote.scrollIntoView();
			original.classList.add("og-attention");
			window.setTimeout(() => {
				original.classList.remove("og-attention");
			}, 600);
		});
	}
}

async function navigateTo(url: URL): Promise<void> {
	let spineItemData: SpineItemData | null;
	const id = url.hash.slice(1);
	url.hash = "";
	try {
		spineItemData = await rs.moveToInSpine(url);
	} catch (err) {
		console.error(`Error jumping to ${url}:`, err);
		return;
	}
	await renderBookPage(spineItemData, 0.0);
	if (id) {
		readerShadowRoot!.getElementById(id)?.scrollIntoView();
	}
}

function handleClickInReader(event: PointerEvent, currentDocUrl: URL): void {
	// find the nearest nesting anchor
	if (!(event.target instanceof Element)) {
		return;
	}
	let elemAnchor: Element | null = event.target;
	while (elemAnchor && !(elemAnchor instanceof HTMLAnchorElement)) {
		elemAnchor = elemAnchor.parentElement;
	}
	if (elemAnchor) {
		event.preventDefault();
		const elemNoteId = anchoredSamePageLocation(elemAnchor);
		if (elemNoteId) {
			previewSamePageLocation(elemAnchor, elemNoteId);
		} else {
			const url = URL.parse(elemAnchor.getAttribute("href") ?? "", currentDocUrl);
			if (url) {
				if (
					url.protocol == "http:" ||
					url.protocol == "https:" ||
					url.protocol == "mailto:" ||
					url.protocol == "tel:"
				) {
					// open externally
					confirm(`Open ${url} using system default application`, {
						title: "Confirm",
						kind: "warning",
					})
						.then(confirmed => {
							if (confirmed) {
								return openUrl(url);
							}
						})
						.catch(err => {
							window.alert(`Error opening ${url}: ${err}`);
						});
				} else {
					navigateTo(url);
				}
			}
		}
	}
}

async function initDetails(): Promise<void> {
	let details: EpubDetails;
	try {
		details = await rs.getDetails();
	} catch (err) {
		console.error("Error loading metadata:", err);
		return;
	}

	Context.epubLang = details.metadata.find(item => item.property == "language")?.value ?? "";
	NavModal.get().onContextLangChange();
	Context.spineLength = details.spineLength;
	const modal = DetailsModal.get();
	modal.init(details);

	getCurrentWebviewWindow().listen("menu/f_d", () => modal.show());
}

async function initToc(): Promise<void> {
	let result: EpubToc;
	try {
		result = await rs.getToc();
	} catch (err) {
		console.error("Error loading TOC:", err);
		elemTocButton!.disabled = true;
		elemTocButton!.title = toc_unavailable_message;
		return;
	}
	const modal = NavModal.get();
	modal.init(result);
	modal.setupTocGoTo(navigateTo);

	getCurrentWebviewWindow().listen("menu/f_n", () => modal.show());
}

export async function initReaderFrame(
	spineItem: SpineItemData,
	percentage: number | null,
): Promise<void> {
	// TODO: merge to one rs call
	initToc();
	initDetails();

	// show reader
	elemFrame!.style.display = ""; // use display value in css
	if (readerShadowRoot == null) {
		readerShadowRoot = elemReaderHost!.attachShadow({ mode: "open" });
	}
	styler = new Styler(readerShadowRoot);
	// setup reader event listeners
	document.body.onkeydown = handleKeyEvent;
	readerShadowRoot.addEventListener("click", event =>
		handleClickInReader(event as PointerEvent, spineItem.path),
	);
	elemTocButton!.onclick = () => NavModal.get().show();

	getCurrentWebviewWindow().listen<FontPrefer>("menu/v_fp", () => {
		styler!.loadAppPrefs();
	});

	renderBookPage(spineItem, percentage);
}

function moveInSpine(next: boolean): void {
	rs.moveInSpine(next)
		.then(result => {
			if (result) {
				renderBookPage(result, next ? 0.0 : 1.0);
			} else {
				window.alert(end_of_spine_message);
			}
		})
		.catch(err => {
			console.error("Error loading next chapter:", err);
		});
}

function handleKeyEvent(event: KeyboardEvent): void {
	if (event.key == "Escape") {
		elemReaderHost?.focus();
	}

	if (eventTargetIsCustomizationInput(event)) {
		return;
	}

	if (event.key == "ArrowRight" || (event.ctrlKey && event.key == "PageDown")) {
		event.preventDefault();
		moveInSpine(true);
	} else if (event.key == "ArrowLeft" || (event.ctrlKey && event.key == "PageUp")) {
		event.preventDefault();
		moveInSpine(false);
	} else if (event.key == "t") {
		event.preventDefault();
		NavModal.get().show();
	} else if (event.key == "d" || event.key == "i") {
		// TODO focus different tabs
		event.preventDefault();
		DetailsModal.get().show();
	}
}
