import { invoke } from "@tauri-apps/api/core";

interface EpubNavPoint {
	label: string;
	content: string;
	playOrder: number;
	children: EpubNavPoint[];
}

let elemClickToOpen: HTMLElement | null;
let elemReaderHost: HTMLElement | null;
let elemFrame: HTMLElement | null;
let elemTocButton: HTMLButtonElement | null;
let elemTocModal: HTMLDialogElement | null;
let elemTocNav: HTMLElement | null;

let epubNavRoot: EpubNavPoint | null = null;

document.addEventListener("DOMContentLoaded", () => {
	elemClickToOpen = document.getElementById("click-to-open");
	elemReaderHost = document.getElementById("reader-host");
	elemFrame = document.getElementById("frame");
	elemTocButton = document.getElementById("toc-button") as HTMLButtonElement;
	elemTocModal = document.getElementById("toc-dialog") as HTMLDialogElement;
	elemTocNav = document.getElementById("toc-nav");

	elemClickToOpen!.addEventListener("click", openEpub);
});

async function renderBookPage(content: string) {
	const shadowRoot = elemReaderHost?.shadowRoot;
	if (!shadowRoot) return;

	const parser = new DOMParser();
	const epubPageDoc = parser.parseFromString(content, "application/xhtml+xml");
	for (const elem of epubPageDoc.body.querySelectorAll<HTMLImageElement>(
		'img[src^="epub://"]',
	)) {
		elem.style.visibility = "hidden";
		const path = elem.src.substring(7);
		invoke("fetch_resource", { path }).then(base64 => {
			elem.src = `data:${base64 as string}`;
			elem.style.visibility = "visible";
		});
	}
	for (const elem of epubPageDoc.body.querySelectorAll<SVGImageElement>("image")) {
		const href = elem.href.baseVal;
		if (href.startsWith("epub://")) {
			elem.style.visibility = "hidden";
			const path = href.substring(7);
			invoke("fetch_resource", { path }).then(base64 => {
				elem.href.baseVal = `data:${base64 as string}`;
				elem.style.visibility = "visible";
			});
		}
	}

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

	shadowRoot.adoptedStyleSheets = stylesheets;
	shadowRoot.replaceChildren();
	shadowRoot.appendChild(epubPageDoc.body);
}

function showToc() {
	elemTocModal!.showModal();
}

function createNavUi() {
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

async function openEpub() {
	const result: string = await invoke("open_epub");
	if (!result) {
		window.alert("Could not open.");
		return;
	}

	invoke("get_toc").then(result => {
		if (result) {
			epubNavRoot = JSON.parse(result as string);
			createNavUi();
		}
	});

	// setup reader
	elemFrame!.style.display = "";
	elemClickToOpen!.remove();
	elemReaderHost!.attachShadow({ mode: "open" });

	document.body.addEventListener("keyup", handleKeyEvent);
	elemTocButton!.addEventListener("click", showToc);

	renderBookPage(result);
}

async function goToNextChapter() {
	const result: string = await invoke("next_chapter");
	if (!result) {
		return; // maybe this is the last chapter
	}

	renderBookPage(result);
}

async function goToPrevChapter() {
	const result: string = await invoke("prev_chapter");
	if (!result) {
		return; // maybe this is the first chapter
	}

	renderBookPage(result);
}

function handleKeyEvent(event: KeyboardEvent) {
	if (event.key === "ArrowRight") {
		event.preventDefault();
		goToNextChapter();
	} else if (event.key === "ArrowLeft") {
		event.preventDefault();
		goToPrevChapter();
	}
}
