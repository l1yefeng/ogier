import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import {
	anchoredSamePageLocation,
	APP_NAME,
	CustomStyles,
	EpubDetails,
	EpubNavPoint,
	isLocationNear,
	markSessionInProgress,
	repairEpubHref,
	SpineItemData,
} from "./base";
import * as rs from "./invoke";
import {
	createBookDetailsUi,
	createNavUi,
	getModalsLanguage,
	loadModalsContent,
	mostRecentNavPoint,
	setModalsLanguage,
	showDetails,
	showNotePreview,
	showToc,
} from "./modals";

// Elements. Initialized in DOMContentLoaded listener.
//

let elemFrame: HTMLElement | null;
let elemReaderHost: HTMLElement | null;
let elemTocButton: HTMLButtonElement | null;
let elemTocBtnLabel: HTMLElement | null;
let elemSpinePosition: HTMLElement | null;
let elemFontSizeInput: HTMLInputElement | null;
let elemSpacingInput: HTMLInputElement | null;

// Other global variables. Lazily initialized.
//

// See openEpub() for initialization.
let readerShadowRoot: ShadowRoot | null = null;

export function loadContent(): void {
	elemFrame = document.getElementById("og-frame") as HTMLDivElement;
	elemReaderHost = document.getElementById("og-reader-host") as HTMLDivElement;
	elemTocButton = document.getElementById("og-toc-button") as HTMLButtonElement;
	elemTocBtnLabel = document.getElementById("og-toc-button-label") as HTMLElement;
	elemSpinePosition = document.getElementById("og-spine-position") as HTMLElement;
	elemFontSizeInput = document.getElementById("og-font-size") as HTMLInputElement;
	elemSpacingInput = document.getElementById("og-spacing") as HTMLInputElement;
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

function stagedCustomStyles(): CustomStyles {
	return {
		baseFontSize: elemFontSizeInput?.valueAsNumber,
		spacingScale: elemSpacingInput?.valueAsNumber,
	};
}

function commitCustomStyles(stylesheet: CSSStyleSheet): void {
	const staged = stagedCustomStyles();
	const baseFontSize = staged.baseFontSize ?? 16;
	const spacingScale = (staged.spacingScale ?? 10) / 10;

	const padding = 16 * Math.pow(spacingScale, 1.5);
	elemReaderHost!.style.paddingInline = `${padding.toFixed(2)}px`;
	const hostStyle = `
		:host {
			--og-space-scale: ${spacingScale};
			--og-font-size: ${baseFontSize}px;
			font-size: var(--og-font-size);
			line-height: ${spacingScale * 1.25};
		}
	`;
	stylesheet.replaceSync(hostStyle);
}

async function renderBookPage(spineItem: SpineItemData, scroll: number | null): Promise<void> {
	const parser = new DOMParser();
	const pageDoc = parser.parseFromString(spineItem.text, "application/xhtml+xml");
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

	// load styles
	// TODO (optimize) don't need to re-fetch the same <link>
	const stylesheets: CSSStyleSheet[] = [];
	// TODO (optimize) parallellize
	for (const elemLink of pageDoc.head.querySelectorAll<HTMLLinkElement>(
		'link[rel="stylesheet"]',
	)) {
		const path = elemLink.href.substring(7);
		let css: string;
		try {
			css = await rs.getResource(path);
			console.debug(`loaded stylesheet ${path}: `, css);
		} catch (err) {
			console.error(`Error loading stylesheet ${path}:`, err);
			continue;
		}
		if (!css) {
			console.error(`Resource not found: ${path}`);
			continue;
		}
		const stylesheet = new CSSStyleSheet();
		stylesheet.replace(css);
		stylesheets.push(stylesheet);
	}

	const stylesheetInPage = new CSSStyleSheet();
	stylesheets.push(stylesheetInPage);
	let cssInPage = `
		img {
			max-width: 100%;
		}
    `;
	for (const elemStyle of pageDoc.head.querySelectorAll<HTMLStyleElement>("style")) {
		const css = elemStyle.textContent;
		if (css) {
			cssInPage += css;
		}
	}
	stylesheetInPage.replace(cssInPage);

	const stylesheetCustom = new CSSStyleSheet();
	stylesheets.push(stylesheetCustom);
	let customStyles: CustomStyles | null = null;
	try {
		customStyles = await rs.getCustomStyles();
	} catch (err) {
		console.error("Error loading saved custom styles:", err);
	}
	if (customStyles) {
		if (customStyles.baseFontSize) {
			elemFontSizeInput!.value = customStyles.baseFontSize.toString();
		}
		if (customStyles.spacingScale) {
			elemSpacingInput!.value = customStyles.spacingScale.toString();
		}
	}
	commitCustomStyles(stylesheetCustom);
	const handleCustomStyleInputChange = () => {
		commitCustomStyles(stylesheetCustom);
		rs.setCustomStyles(stagedCustomStyles());
	};
	elemFontSizeInput!.onchange = handleCustomStyleInputChange;
	elemSpacingInput!.onchange = handleCustomStyleInputChange;

	readerShadowRoot!.adoptedStyleSheets = stylesheets;
	readerShadowRoot!.replaceChildren();
	// insert the body
	readerShadowRoot!.appendChild(pageBody);
	if (scroll != null) {
		elemReaderHost!.scroll({ top: scroll, behavior: "instant" });
	}

	elemSpinePosition!.textContent = `Position: ${spineItem.position}`;

	const btn = mostRecentNavPoint(spineItem.path, 0);
	if (btn) {
		elemTocBtnLabel!.lang = getModalsLanguage();
		elemTocBtnLabel!.textContent = btn.textContent;
	} else {
		elemTocBtnLabel!.removeAttribute("lang");
		elemTocBtnLabel!.textContent = "Table of contents";
	}

	markSessionInProgress();
}

function createPreviewContentRoot(elemLocation: HTMLElement): HTMLElement {
	// First, try to locate a <li>, and use its content
	let elemLi: HTMLLIElement | null = null;
	if (elemLocation instanceof HTMLLIElement) {
		elemLi = elemLocation;
	} else if (elemLocation.parentElement instanceof HTMLLIElement) {
		elemLi = elemLocation.parentElement;
	}
	if (elemLi) {
		// clone the element
		return elemLi.cloneNode(true) as HTMLLIElement;
	}

	// Next, use its parent if it's a <a>
	if (elemLocation instanceof HTMLAnchorElement) {
		const parent = elemLocation.parentElement;
		if (parent) {
			return parent.cloneNode(true) as HTMLElement;
		}
	}

	return elemLocation.cloneNode(true) as HTMLElement;
}

function createSamePageLocationPreviewContent(
	anchor: HTMLElement,
	id: string,
): HTMLElement | null {
	const elemLocation = readerShadowRoot!.getElementById(id);
	if (!elemLocation) {
		return null;
	}

	const previewContentRoot = createPreviewContentRoot(elemLocation);
	for (const elem of previewContentRoot.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
		const idPointedByElem = anchoredSamePageLocation(elem)!;
		if (isLocationNear(idPointedByElem, anchor)) {
			const subs = document.createElement("span");
			subs.classList.add("og-note-icon");
			elem.replaceWith(subs);
		} else {
			elem.href = "";
		}
	}

	if (!previewContentRoot.textContent?.trim()) {
		return null;
	}

	return previewContentRoot;
}

function previewSamePageLocation(anchor: HTMLElement, id: string): void {
	const elem = readerShadowRoot!.getElementById(id);
	if (elem) {
		const contentRoot = createSamePageLocationPreviewContent(anchor, id);
		if (contentRoot) {
			showNotePreview(contentRoot);
		}
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
	await renderBookPage(spineItemData, 0);
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
		const samePageId = anchoredSamePageLocation(elemAnchor);
		if (samePageId) {
			previewSamePageLocation(elemAnchor, samePageId);
		} else if (elemAnchor.href.startsWith("epub://")) {
			const [path, locationId] = elemAnchor.href.substring(7).split("#", 2);
			navigateTo(path, locationId);
		}
	}
}

function refreshUiWithBookDetails(details: EpubDetails): void {
	if (details.metadata.language) {
		const lang = details.metadata.language[0];
		if (lang) {
			elemReaderHost!.lang = lang;
			setModalsLanguage(lang);
		}
	}
	if (details.displayTitle) {
		document.title = `${details.displayTitle} - ${APP_NAME}`;
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

	refreshUiWithBookDetails(details);
	createBookDetailsUi(details);

	getCurrentWebviewWindow().listen("menu/file::details", showDetails);
}

async function initToc(): Promise<void> {
	let result: EpubNavPoint;
	try {
		result = await rs.getToc();
	} catch (err) {
		console.error("Error loading TOC:", err);
		return;
	}
	createNavUi(result, navigateTo);

	getCurrentWebviewWindow().listen("menu/file::table-of-contents", showToc);
}

export async function initReaderFrame(spineItem: SpineItemData): Promise<void> {
	initToc();
	initDetails();

	// show reader
	elemFrame!.style.display = ""; // use display value in css
	readerShadowRoot = elemReaderHost!.attachShadow({ mode: "open" });
	// setup reader event listeners
	document.body.addEventListener("keyup", handleKeyEvent);
	readerShadowRoot.addEventListener("click", event =>
		handleClickInReader(event as PointerEvent),
	);
	elemTocButton!.addEventListener("click", showToc);

	renderBookPage(spineItem, 0);
}

function moveInSpine(next: boolean): void {
	rs.moveInSpine(next)
		.then(result => {
			if (result) {
				renderBookPage(result, next ? 0 : 1e6);
			} else {
				window.alert("No more pages.");
			}
		})
		.catch(err => {
			console.error("Error loading next chapter:", err);
		});
}

function handleKeyEvent(event: KeyboardEvent): void {
	if (event.target == elemFontSizeInput || event.target == elemSpacingInput) {
		return;
	}

	if (event.key == "ArrowRight" || (event.ctrlKey && event.key == "PageDown")) {
		event.preventDefault();
		moveInSpine(true);
	} else if (event.key == "ArrowLeft" || (event.ctrlKey && event.key == "PageUp")) {
		event.preventDefault();
		moveInSpine(false);
	}
}
