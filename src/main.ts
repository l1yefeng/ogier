import { invoke } from "@tauri-apps/api/core";

import {
	anchoredSamePageLocation,
	APP_NAME,
	EpubMetadata,
	EpubNavPoint,
	isLocationNear,
	repairEpubHref,
} from "./base";

// Elements. Initialized in DOMContentLoaded listener.
//

let elemReaderHost: HTMLElement | null;
let elemFrame: HTMLElement | null;
let elemTocButton: HTMLButtonElement | null;
let elemTocModal: HTMLDialogElement | null;
let elemTocNav: HTMLElement | null;
let elemPreviewModal: HTMLDialogElement | null;
let elemPreviewDiv: HTMLDivElement | null;

// Other global variables. Lazily initialized.
//

// See openEpub() for initialization.
let readerShadowRoot: ShadowRoot | null = null;
// See initToc() for initialization.
let epubNavRoot: EpubNavPoint | null = null;
let epubMetadata: EpubMetadata | null;

document.addEventListener("DOMContentLoaded", () => {
	elemFrame = document.getElementById("og-frame") as HTMLDivElement;
	elemReaderHost = document.getElementById("og-reader-host") as HTMLDivElement;
	elemTocButton = document.getElementById("og-toc-button") as HTMLButtonElement;
	elemTocModal = document.getElementById("og-toc-modal") as HTMLDialogElement;
	elemTocNav = document.getElementById("og-toc-nav") as HTMLElement;
	elemPreviewModal = document.getElementById("og-preview-modal") as HTMLDialogElement;
	elemPreviewDiv = document.getElementById("og-preview-div") as HTMLDivElement;

	const elemClickToOpen = document.getElementById("og-click-to-open") as HTMLElement;
	elemClickToOpen.addEventListener("click", event => handleClickToOpen(event as PointerEvent));
});

function loadImageElement(
	elem: HTMLImageElement | SVGImageElement,
	path: string,
	useDataBase64: (base64: string) => void,
): void {
	elem.style.visibility = "hidden";
	invoke("fetch_resource", { path })
		.then(base64 => {
			if (base64) {
				useDataBase64(base64 as string);
				elem.style.visibility = "";
			} else {
				console.error(`Resource not found: ${path}`);
			}
		})
		.catch(err => {
			console.error(`Error loading image ${path}:`, err);
		});
}

async function renderBookPage(content: string): Promise<void> {
	const parser = new DOMParser();
	const epubPageDoc = parser.parseFromString(content, "application/xhtml+xml");

	// load all images: <img> and svg <image>
	for (const elem of epubPageDoc.body.querySelectorAll<HTMLImageElement>(
		'img[src^="epub://"]',
	)) {
		loadImageElement(elem, elem.src.substring(7), base64 => {
			elem.src = `data:${base64 as string}`;
		});
	}
	for (const elem of epubPageDoc.body.querySelectorAll<SVGImageElement>("image")) {
		const href = elem.href.baseVal;
		if (href.startsWith("epub://")) {
			loadImageElement(elem, href.substring(7), base64 => {
				elem.href.baseVal = `data:${base64 as string}`;
			});
		}
	}

	// repair anchor element hrefs
	new Promise(() => {
		for (const elem of epubPageDoc.body.querySelectorAll<HTMLAnchorElement>(
			'a[href^="epub://"]',
		)) {
			repairEpubHref(elem);
		}
	});

	// load styles
	// TODO (optimize) don't need to re-fetch the same <link>
	const stylesheets: CSSStyleSheet[] = [];
	// TODO (optimize) parallellize
	for (const elemLink of epubPageDoc.head.querySelectorAll<HTMLLinkElement>(
		'link[rel="stylesheet"]',
	)) {
		const path = elemLink.href.substring(7);
		let css: string;
		try {
			css = await invoke("fetch_resource", { path });
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
	let styleElemCss = `
		img {
			max-width: 100%;
		}
    `;
	for (const elemStyle of epubPageDoc.head.querySelectorAll<HTMLStyleElement>("style")) {
		const css = elemStyle.textContent;
		if (css) {
			styleElemCss += css;
		}
	}
	const stylesheet = new CSSStyleSheet();
	stylesheet.replace(styleElemCss);
	stylesheets.push(stylesheet);

	readerShadowRoot!.adoptedStyleSheets = stylesheets;
	readerShadowRoot!.replaceChildren();
	// insert the body
	readerShadowRoot!.appendChild(epubPageDoc.body);
}

function showToc(): void {
	elemTocModal!.showModal();
}

function createNavUi(): void {
	const ol = document.createElement("ol");
	elemTocNav!.appendChild(ol);

	ol.append(...epubNavRoot!.children.map(createNavPoint));

	elemTocModal!.addEventListener("close", async () => {
		const value = elemTocModal!.returnValue;
		if (value) {
			const [path, locationId] = value.split("#", 2);
			let content: string;
			try {
				content = await invoke("jump_to_chapter", { path });
			} catch (err) {
				console.error(`Error jumping to ${path}:`, err);
				return;
			}
			if (!content) {
				console.error(`Page not found: ${path}`);
				return;
			}
			await renderBookPage(content);
			if (locationId) {
				readerShadowRoot!.getElementById(locationId)?.scrollIntoView();
			}
		}
	});
}

function createNavPoint(navPoint: EpubNavPoint): HTMLLIElement {
	const elemNavPoint = document.createElement("li");

	const elemNavBtn = document.createElement("button");
	elemNavBtn.textContent = navPoint.label;
	elemNavBtn.value = navPoint.content;
	elemNavPoint.appendChild(elemNavBtn);

	if (navPoint.children.length > 0) {
		const sub = document.createElement("ol");
		sub.append(...navPoint.children.map(createNavPoint));
		elemNavPoint.appendChild(sub);
	}

	return elemNavPoint;
}

function handleClickToOpen(event: PointerEvent): void {
	invoke("open_epub")
		.then(result => {
			if (result) {
				// got the book.
				(event.target as HTMLElement).remove();
				openEpub(result as string);
			}
		})
		.catch(err => {
			window.alert(err);
		});
}

function createSamePageLocationPreview(anchor: HTMLElement, id: string): boolean {
	const elemLocation = readerShadowRoot!.getElementById(id);
	if (elemLocation) {
		let elemLi: HTMLLIElement | null = null;
		if (elemLocation instanceof HTMLLIElement) {
			elemLi = elemLocation;
		} else if (elemLocation.parentElement instanceof HTMLLIElement) {
			elemLi = elemLocation.parentElement;
		}
		if (elemLi) {
			// clone the element
			elemLi = elemLi.cloneNode(true) as HTMLLIElement;
			for (const elem of elemLi.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
				const id = anchoredSamePageLocation(elem)!;
				if (isLocationNear(id, anchor)) {
					elem.remove();
					break;
				}
			}
			elemPreviewDiv!.replaceChildren(...elemLi.childNodes);
			return true;
		} else {
			// TODO
			return false;
		}
	} else {
		return false;
	}
}

function previewSamePageLocation(anchor: HTMLElement, id: string): void {
	const elem = readerShadowRoot!.getElementById(id);
	if (elem) {
		if (createSamePageLocationPreview(anchor, id)) {
			elemPreviewModal!.showModal();
		}
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
			// TODO
			console.warn("Unimplemented: preview location");
		}
	}
}

async function initMetadata(): Promise<void> {
	let result: EpubMetadata;
	try {
		result = await invoke("get_metadata");
	} catch (err) {
		console.error("Error loading metadata:", err);
		return;
	}
	epubMetadata = result;

	// apply to context
	if (epubMetadata.language) {
		const lang = epubMetadata.language[0];
		if (lang) {
			elemReaderHost!.lang = lang;
			elemTocNav!.lang = lang;
			elemPreviewDiv!.lang = lang;
		}
	}
	if (epubMetadata.title) {
		const epubTitleDisplay = epubMetadata.title.filter(t => t).join(" · ");
		if (epubTitleDisplay) {
			document.title = `${epubTitleDisplay} - ${APP_NAME}`;
		}
	}
}

async function initToc(): Promise<void> {
	let result: EpubNavPoint;
	try {
		result = await invoke("get_toc");
	} catch (err) {
		console.error("Error loading TOC:", err);
		return;
	}
	epubNavRoot = result;
	createNavUi();
}

async function openEpub(pageContent: string): Promise<void> {
	initToc();
	initMetadata();

	// show reader
	elemFrame!.style.display = "";
	readerShadowRoot = elemReaderHost!.attachShadow({ mode: "open" });
	// setup reader event listeners
	document.body.addEventListener("keyup", handleKeyEvent);
	readerShadowRoot.addEventListener("click", event =>
		handleClickInReader(event as PointerEvent),
	);
	elemTocButton!.addEventListener("click", showToc);

	renderBookPage(pageContent);
}

function goToChapter(command: string, onEmptyResult: () => void): void {
	invoke(command)
		.then(result => {
			if (result) {
				renderBookPage(result as string);
			} else {
				onEmptyResult();
			}
		})
		.catch(err => {
			console.error("Error loading next chapter:", err);
		});
}

function goToNextChapter(): void {
	goToChapter("next_chapter", () => {
		window.alert("This is the last chapter.");
	});
}

function goToPrevChapter(): void {
	goToChapter("prev_chapter", () => {
		window.alert("This is the first chapter.");
	});
}

function handleKeyEvent(event: KeyboardEvent): void {
	if (event.key === "ArrowRight") {
		event.preventDefault();
		goToNextChapter();
	} else if (event.key === "ArrowLeft") {
		event.preventDefault();
		goToPrevChapter();
	}
}
