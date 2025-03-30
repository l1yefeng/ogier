import { invoke } from "@tauri-apps/api/core";

let elemClickToOpen: HTMLElement | null;
let elemReaderHost: HTMLElement | null;

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

async function openEpub() {
	const result: string = await invoke("open_epub");
	if (!result) {
		window.alert("Could not open.");
		return;
	}

	// setup reader
	elemClickToOpen!.remove();
	elemReaderHost!.attachShadow({ mode: "open" });

	document.body.addEventListener("keyup", handleKeyEvent);

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

document.addEventListener("DOMContentLoaded", () => {
	elemClickToOpen = document.getElementById("click-to-open");
	elemClickToOpen!.addEventListener("click", openEpub);

	elemReaderHost = document.getElementById("reader-host");
});
