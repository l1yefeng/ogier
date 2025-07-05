import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
	end_of_spine_message,
	toc_default_title,
	toc_unavailable_message,
} from "./strings.json";

import {
	AboutPub,
	anchoredSamePageLocation,
	CustomStyles,
	FontPrefer,
	getCurrentPosition,
	getCurrentPositionInverse,
	getCurrentPositionPx,
	isLocationNear,
	markSessionInProgress,
	TaskRepeater,
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

// function loadImageElement(
// 	elem: HTMLImageElement | SVGImageElement,
// 	url: URL,
// 	useUri: (uri: string) => void,
// ): void {
// 	// TODO: debugging, and meanwhile maybe we use `register_asynchronous_uri_scheme_protocol`
// 	console.debug(`ENTER: loadImageElement(${url})`);
// 	useUri(toResourceUri(url));
// }

/**
 * Call this at some point during the loading of a page (Docuemnt).
 *
 * @param head `<head>` element of the page the reader is loading.
 */
async function loadPageStyles(head: HTMLHeadElement): Promise<HTMLLinkElement[]> {
	// const linkedUrls: URL[] = [];
	const stylesheetLinks: HTMLLinkElement[] = [];
	for (const elemLink of head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
		const uri = URL.parse(elemLink.getAttribute("href") ?? "", Context.readingPositionUrl!);
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

function fetchContentDoc(url: URL): Promise<Document> {
	const uri = toResourceUri(url);
	console.debug(`fetchContentDoc ${uri}`);
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("GET", uri);
		// TODO: use exact same origin? see https://docs.rs/tauri/2.6.2/tauri/struct.Builder.html#method.register_uri_scheme_protocol
		xhr.setRequestHeader("Accept", "application/xhtml+xml");
		xhr.setRequestHeader("Accept", "image/svg+xml");
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

async function renderBookPage(url: URL, percentage: number | null): Promise<void> {
	console.debug("ENTER: renderBookPage");
	Context.readingPositionUrl = url;

	// Remove everything first
	readerShadowRoot!.replaceChildren();

	console.debug("parsing doc");
	const doc = await fetchContentDoc(url);
	Context.spineItemLang = doc.documentElement.lang;
	elemReaderHost!.lang = Context.spineItemLang || Context.getEpubLang();
	const pageBody = doc.body;

	// load all images: <img> and svg <image>
	for (const elem of pageBody.querySelectorAll<HTMLImageElement>("img")) {
		const imgUrl = URL.parse(elem.src, url);
		if (imgUrl) {
			elem.src = toResourceUri(imgUrl);
			// loadImageElement(elem, elemUrl, uri => {
			// 	elem.src = uri;
			// });
		}
	}
	for (const elem of pageBody.querySelectorAll<SVGImageElement>("image")) {
		const imgUrl = URL.parse(elem.href.baseVal, url);
		if (imgUrl) {
			elem.href.baseVal = toResourceUri(imgUrl);
			// loadImageElement(elem, imgUrl, uri => {
			// 	elem.href.baseVal = uri;
			// });
		}
	}

	// repair anchor element hrefs
	new Promise(() => {
		for (const elem of pageBody.querySelectorAll<HTMLAnchorElement>("a")) {
			const resourceUrl = URL.parse(elem.getAttribute("href")!, url);
			if (resourceUrl) {
				elem.href = toResourceUri(resourceUrl);
				// repairEpubHref(elem, spineItem.path);
			}
		}
	});

	console.debug("CALL: loadPageStyles (skipped)");
	const stylesheetLinks = await loadPageStyles(doc.head);

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

	elemSpinePosition!.textContent = `to be removed`;

	refreshTocBtnLabelTask.restart(() => {
		const hostRect = elemReaderHost!.getBoundingClientRect();
		const bodyRect = pageBody.getBoundingClientRect();
		const btn = NavModal.get().mostRecentNavPoint(
			url.pathname,
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
		Context.readingPositionPercentage = getCurrentPosition(hostRect, bodyRect);
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
	const id = url.hash.slice(1);
	url.hash = "";
	await renderBookPage(url, 0.0);
	if (id) {
		readerShadowRoot!.getElementById(id)?.scrollIntoView();
	}
}

function handleClickInReader(event: PointerEvent): void {
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
			const url = URL.parse(elemAnchor.getAttribute("href") ?? "", Context.readingPositionUrl!);
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
	NavModal.get().onContextLangChange();
	const modal = DetailsModal.get();
	modal.init();

	getCurrentWebviewWindow().listen("menu/f_d", () => modal.show());
}

async function initToc(): Promise<void> {
	try {
		const { pubTocUrl, pubTocIsLegacy } = Context.openedEpub!;
		console.debug(`Init toc with ${pubTocUrl} (legacy: ${pubTocIsLegacy})`);
		throw new Error("Unimplemented: initToc");
		// result = await rs.getToc();
	} catch (err) {
		console.error("Error loading TOC:", err);
		elemTocButton!.disabled = true;
		elemTocButton!.title = toc_unavailable_message;
		return;
	}
	// const modal = NavModal.get();
	// modal.init(result);
	// modal.setupTocGoTo(navigateTo);

	// getCurrentWebviewWindow().listen("menu/f_n", () => modal.show());
}

export async function initReaderFrame(about: AboutPub): Promise<void> {
	Context.openedEpub = about;

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
		handleClickInReader(event as PointerEvent),
	);
	elemTocButton!.onclick = () => NavModal.get().show();

	getCurrentWebviewWindow().listen<FontPrefer>("menu/v_fp", () => {
		styler!.loadAppPrefs();
	});

	// TODO: progress
	const url = about.pubLandingPage;
	renderBookPage(url, null);
}

function moveInSpine(forward: boolean): void {
	const spine = Context.openedEpub!.pubSpine;
	let index = Context.getReadingPositionInSpine();

	index += forward ? +1 : -1;
	if (index < 0 || index >= spine.length) {
		window.alert(end_of_spine_message);
		return;
	}
	const percentage = forward ? 0.0 : 1.0;
	renderBookPage(spine[index], percentage);
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

function toResourceUri(uri: URL): string {
	return convertFileSrc(uri.pathname.slice(1), "epub");
}
