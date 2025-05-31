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
	repairEpubHref,
	SpineItemData,
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
import {
	createBookDetailsUi,
	createTocUi,
	loadModalsContent,
	mostRecentNavPoint,
	setModalsLanguage,
	setupNotePreviewGoThere,
	setupTocGoTo,
	showDetails,
	showNotePreview,
	showToc,
} from "./modals";
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
	loadModalsContent();
}

function loadImageElement(
	elem: HTMLImageElement | SVGImageElement,
	path: string,
	useDataBase64: (base64: string) => void,
): void {
	elem.style.visibility = "hidden";
	rs.getResource(path)
		.then(base64 => {
			if (base64) {
				useDataBase64(base64);
				elem.style.visibility = "";
			} else {
				console.error(`Resource not found: ${path}`);
			}
		})
		.catch(err => {
			console.error(`Error loading image ${path}:`, err);
		});
}

async function loadPageStyles(head: HTMLHeadElement): Promise<void> {
	const linkedPaths = [];
	for (const elemLink of head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
		const path = elemLink.href.substring(7);
		linkedPaths.push(path);
		elemLink.remove();
	}
	await styler!.load(linkedPaths);

	let cssInPage = "";
	for (const elemStyle of head.querySelectorAll<HTMLStyleElement>("style")) {
		const css = elemStyle.textContent;
		if (css) {
			cssInPage += css;
		}
	}
	styler!.setStyleElemsCss(cssInPage);
}

async function renderBookPage(
	spineItem: SpineItemData,
	percentage: number | null,
): Promise<void> {
	// Remove everything first
	readerShadowRoot!.replaceChildren();

	const parser = new DOMParser();
	const pageDoc = parser.parseFromString(spineItem.text, spineItem.mimetype);
	Context.spineItemLang = pageDoc.documentElement.lang;
	elemReaderHost!.lang = Context.spineItemLang || Context.epubLang;
	const pageBody = pageDoc.body;

	// load all images: <img> and svg <image>
	for (const elem of pageBody.querySelectorAll<HTMLImageElement>('img[src^="epub://"]')) {
		loadImageElement(elem, elem.src.substring(7), base64 => {
			elem.src = `data:${base64}`;
		});
	}
	for (const elem of pageBody.querySelectorAll<SVGImageElement>("image")) {
		const href = elem.href.baseVal;
		if (href.startsWith("epub://")) {
			loadImageElement(elem, href.substring(7), base64 => {
				elem.href.baseVal = `data:${base64}`;
			});
		}
	}

	// repair anchor element hrefs
	new Promise(() => {
		for (const elem of pageBody.querySelectorAll<HTMLAnchorElement>('a[href^="epub://"]')) {
			repairEpubHref(elem, spineItem.path);
		}
	});

	await loadPageStyles(pageDoc.head);

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
	readerShadowRoot!.appendChild(pageBody);
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
		const btn = mostRecentNavPoint(
			spineItem.path,
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
		showNotePreview(clone);
		setupNotePreviewGoThere(() => {
			elemNote.scrollIntoView();
			original.classList.add("og-attention");
			window.setTimeout(() => {
				original.classList.remove("og-attention");
			}, 600);
		});
	}
}

async function navigateTo(path: string, locationId?: string): Promise<void> {
	let spineItemData: SpineItemData | null;
	try {
		spineItemData = await rs.moveToInSpine(path);
	} catch (err) {
		console.error(`Error jumping to ${path}:`, err);
		return;
	}
	await renderBookPage(spineItemData, 0.0);
	if (locationId) {
		readerShadowRoot!.getElementById(locationId)?.scrollIntoView();
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
			const href = elemAnchor.href;
			if (href.startsWith("epub://")) {
				const [path, locationId] = elemAnchor.href.substring(7).split("#", 2);
				navigateTo(path, locationId);
			} else if (
				href.startsWith("http://") ||
				href.startsWith("https://") ||
				href.startsWith("mailto:") ||
				href.startsWith("tel:")
			) {
				// open externally
				confirm(`Open ${href} using system default application`, {
					title: "Confirm",
					kind: "warning",
				})
					.then(confirmed => {
						if (confirmed) {
							return openUrl(href);
						}
					})
					.catch(err => {
						window.alert(`Error opening ${href}: ${err}`);
					});
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
	setModalsLanguage();
	Context.spineLength = details.spineLength;
	createBookDetailsUi(details);

	getCurrentWebviewWindow().listen("menu/f_d", showDetails);
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
	createTocUi(result);
	setupTocGoTo(navigateTo);

	getCurrentWebviewWindow().listen("menu/f_toc", showToc);
}

export async function initReaderFrame(
	spineItem: SpineItemData,
	percentage: number | null,
): Promise<void> {
	// TODO: don't duplicate
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
	elemTocButton!.onclick = showToc;

	getCurrentWebviewWindow().listen<FontPrefer>("menu/v_fp", event => {
		styler!.fontPreference = event.payload;
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
		showToc();
	} else if (event.key == "d" || event.key == "i") {
		// TODO focus different tabs
		event.preventDefault();
		showDetails();
	}
}
