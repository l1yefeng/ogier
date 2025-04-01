import { invoke } from "@tauri-apps/api/core";

import { anchoredSamePageLocation, EpubNavPoint, isLocationNear, repairEpubHref } from "./base";

let elemReaderHost: HTMLElement | null;
let elemFrame: HTMLElement | null;
let elemTocButton: HTMLButtonElement | null;
let elemTocModal: HTMLDialogElement | null;
let elemTocNav: HTMLElement | null;
let elemPreviewModal: HTMLDialogElement | null;
let elemPreviewContainer: HTMLDivElement | null;

let readerShadowRoot: ShadowRoot | null = null;
let epubNavRoot: EpubNavPoint | null = null;

document.addEventListener("DOMContentLoaded", () => {
	elemFrame = document.getElementById("frame") as HTMLDivElement;
	elemReaderHost = document.getElementById("reader-host") as HTMLDivElement;
	elemTocButton = document.getElementById("toc-button") as HTMLButtonElement;
	elemTocModal = document.getElementById("toc-dialog") as HTMLDialogElement;
	elemTocNav = document.getElementById("toc-nav") as HTMLElement;
	elemPreviewModal = document.getElementById("preview-dialog") as HTMLDialogElement;
	elemPreviewContainer = document.getElementById("preview-container") as HTMLDivElement;

	const elemClickToOpen = document.getElementById("click-to-open") as HTMLElement;
	elemClickToOpen.addEventListener("click", event => handleClickToOpen(event as PointerEvent));
});

async function renderBookPage(content: string): Promise<void> {
	const parser = new DOMParser();
	const epubPageDoc = parser.parseFromString(content, "application/xhtml+xml");

	// load all images: <img> and svg <image>
	for (const elem of epubPageDoc.body.querySelectorAll<HTMLImageElement>(
		'img[src^="epub://"]',
	)) {
		elem.style.visibility = "hidden";
		const path = elem.src.substring(7);
		invoke("fetch_resource", { path }).then(base64 => {
			elem.src = `data:${base64 as string}`;
			elem.style.visibility = "";
		});
	}
	for (const elem of epubPageDoc.body.querySelectorAll<SVGImageElement>("image")) {
		const href = elem.href.baseVal;
		if (href.startsWith("epub://")) {
			elem.style.visibility = "hidden";
			const path = href.substring(7);
			invoke("fetch_resource", { path }).then(base64 => {
				elem.href.baseVal = `data:${base64 as string}`;
				elem.style.visibility = "";
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
		const css: string = await invoke("fetch_resource", { path });
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
}

function createNavPoint(navPoint: EpubNavPoint): HTMLLIElement {
	const elemNavPoint = document.createElement("li");

	const elemNavAnchor = document.createElement("a");
	elemNavAnchor.textContent = navPoint.label;
	elemNavAnchor.href = `epub://${navPoint.content}`;
	elemNavPoint.appendChild(elemNavAnchor);

	if (navPoint.children.length > 0) {
		const sub = document.createElement("ol");
		sub.append(...navPoint.children.map(createNavPoint));
		elemNavPoint.appendChild(sub);
	}

	return elemNavPoint;
}

async function handleClickToOpen(event: PointerEvent): Promise<void> {
	const result: string = await invoke("open_epub");
	if (!result) {
		window.alert("Could not open.");
		return;
	}

	// got the book.
	(event.target as HTMLElement).remove();
	openEpub(result);
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
			elemPreviewContainer!.replaceChildren(...elemLi.childNodes);
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

async function openEpub(pageContent: string): Promise<void> {
	invoke("get_toc").then(result => {
		if (result) {
			epubNavRoot = JSON.parse(result as string);
			createNavUi();
		}
	});

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

async function goToNextChapter(): Promise<void> {
	const result: string = await invoke("next_chapter");
	if (!result) {
		return; // maybe this is the last chapter
	}

	renderBookPage(result);
}

async function goToPrevChapter(): Promise<void> {
	const result: string = await invoke("prev_chapter");
	if (!result) {
		return; // maybe this is the first chapter
	}

	renderBookPage(result);
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
