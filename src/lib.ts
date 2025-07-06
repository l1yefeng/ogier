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
	FilewiseStyles,
	fetchXml,
	FontPrefer,
	getCurrentPosition,
	getCurrentPositionInverse,
	getCurrentPositionPx,
	isLocationNear,
	markSessionInProgress,
	setElementUrl,
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

/**
 * Call this at some point during the loading of a page (Docuemnt).
 *
 * @param head `<head>` element of the page the reader is loading.
 */
async function loadPageStyles(head: HTMLHeadElement): Promise<HTMLLinkElement[]> {
	const stylesheetLinks: HTMLLinkElement[] = [];
	for (const elemLink of head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
		const href = elemLink.getAttribute("href");
		if (!href) continue;
		const url = URL.parse(href, Context.getReadingPositionUrl());
		if (url) {
			setElementUrl(elemLink, url);
			stylesheetLinks.push(elemLink);
		}
	}

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
	url: URL,
	percentage: number | null,
	indexInSpine?: number,
): Promise<void> {
	console.debug("ENTER: renderBookPage");
	if (indexInSpine != undefined) {
		Context.setReadingPositionInSpine(indexInSpine);
	} else {
		Context.setReadingPositionUrl(url);
	}

	// Remove everything first
	readerShadowRoot!.replaceChildren();

	console.debug("parsing doc");
	const doc = await fetchXml(url, true);
	Context.spineItemLang = doc.documentElement.lang;
	elemReaderHost!.lang = Context.spineItemLang || Context.getEpubLang();
	const pageBody = doc.body;

	// load all images: <img> and svg <image>
	for (const elem of pageBody.querySelectorAll<HTMLImageElement>("img")) {
		const imgUrl = URL.parse(elem.src, url);
		if (imgUrl) {
			setElementUrl(elem, imgUrl);
		}
	}
	for (const elem of pageBody.querySelectorAll<SVGImageElement>("image")) {
		const imgUrl = URL.parse(elem.href.baseVal, url);
		if (imgUrl) {
			setElementUrl(elem, imgUrl);
		}
	}

	// repair anchor element hrefs
	new Promise(() => {
		for (const elem of pageBody.querySelectorAll<HTMLAnchorElement>("a")) {
			const resourceUrl = URL.parse(elem.getAttribute("href")!, url);
			if (resourceUrl) {
				setElementUrl(elem, resourceUrl);
			}
		}
	});

	console.debug("CALL: loadPageStyles (skipped)");
	const stylesheetLinks = await loadPageStyles(doc.head);

	let filewiseStyles: Partial<FilewiseStyles>;
	try {
		filewiseStyles = (await rs.getFilewiseStyles()) || {};
	} catch (err) {
		console.error("Error loading saved filewise styles:", err);
		filewiseStyles = {};
	}
	const localStylesCommit = (styles: FilewiseStyles) => (styler!.filewiseStyles = styles);
	commitCustomStylesFromSaved(filewiseStyles, localStylesCommit);
	activateCustomizationInput(localStylesCommit, rs.setFilewiseStyles);

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
		rs.setReadingPosition(
			Context.getReadingPositionUrl(),
			getCurrentPosition(hostRect, bodyRect),
		);
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
			const url = URL.parse(
				elemAnchor.getAttribute("href") ?? "",
				Context.getReadingPositionUrl(),
			);
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

async function initDetailsAndTocModals(): Promise<void> {
	NavModal.get().onContextLangChange();
	const webWindow = getCurrentWebviewWindow();

	const detailsModal = DetailsModal.get();
	detailsModal.init();

	webWindow.listen("menu/f_d", () => detailsModal.show());

	const navModal = NavModal.get();
	try {
		await navModal.init();
	} catch (err) {
		console.error("Error loading TOC:", err);
		elemTocButton!.disabled = true;
		elemTocButton!.title = toc_unavailable_message;
		return;
	}
	navModal.setupTocGoTo(navigateTo);

	webWindow.listen("menu/f_n", () => navModal.show());
}

export async function initReaderFrame(about: AboutPub): Promise<void> {
	Context.setOpenedEpub(about);

	initDetailsAndTocModals(); // don't wait

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

	// retrieve reading position
	const position = await rs.getReadingPosition();
	const [url, percentage] = position == null ? [about.pubLandingPage, null] : position;
	await renderBookPage(url, percentage);
}

function moveInSpine(forward: boolean): void {
	const spine = Context.getOpenedEpub().pubSpine;
	let index = Context.getReadingPositionInSpine();

	index += forward ? +1 : -1;
	if (index < 0 || index >= spine.length) {
		window.alert(end_of_spine_message);
		return;
	}
	const percentage = forward ? 0.0 : 1.0;
	renderBookPage(spine[index], percentage, index);
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
