import {
	anchoredSamePageLocation,
	APP_NAME,
	CustomStyles,
	EpubMetadata,
	EpubNavPoint,
	isLocationNear,
	repairEpubHref,
	SpineItemData,
} from "./base";
import * as rs from "./invoke";

// Elements. Initialized in DOMContentLoaded listener.
//

let elemReaderHost: HTMLElement | null;
let elemFrame: HTMLElement | null;
let elemTocButton: HTMLButtonElement | null;
let elemDetailsButton: HTMLButtonElement | null;
let elemTocModal: HTMLDialogElement | null;
let elemTocNav: HTMLElement | null;
let elemPreviewModal: HTMLDialogElement | null;
let elemPreviewDiv: HTMLDivElement | null;
let elemDetailsModal: HTMLDialogElement | null;
let elemBookDetailsTable: HTMLTableElement | null;
let elemSpinePosition: HTMLElement | null;
let elemFontSizeInput: HTMLInputElement | null;
let elemSpacingInput: HTMLInputElement | null;

// Other global variables. Lazily initialized.
//

// See openEpub() for initialization.
let readerShadowRoot: ShadowRoot | null = null;

document.addEventListener("DOMContentLoaded", () => {
	elemFrame = document.getElementById("og-frame") as HTMLDivElement;
	elemReaderHost = document.getElementById("og-reader-host") as HTMLDivElement;
	elemTocButton = document.getElementById("og-toc-button") as HTMLButtonElement;
	elemDetailsButton = document.getElementById("og-details-button") as HTMLButtonElement;
	elemTocModal = document.getElementById("og-toc-modal") as HTMLDialogElement;
	elemTocNav = document.getElementById("og-toc-nav") as HTMLElement;
	elemPreviewModal = document.getElementById("og-preview-modal") as HTMLDialogElement;
	elemPreviewDiv = document.getElementById("og-preview-div") as HTMLDivElement;
	elemDetailsModal = document.getElementById("og-details-modal") as HTMLDialogElement;
	elemBookDetailsTable = document.getElementById("og-book-details") as HTMLTableElement;
	elemSpinePosition = document.getElementById("og-spine-position") as HTMLElement;
	elemFontSizeInput = document.getElementById("og-font-size") as HTMLInputElement;
	elemSpacingInput = document.getElementById("og-spacing") as HTMLInputElement;

	const elemClickToOpen = document.getElementById("og-click-to-open") as HTMLElement;
	elemClickToOpen.addEventListener("click", event => handleClickToOpen(event as PointerEvent));
});

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
	const spacingScale = (staged.spacingScale ?? 100) / 100;

	elemReaderHost!.style.paddingInline = `${16 * Math.pow(spacingScale, 2)}px`;
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
	const epubPageDoc = parser.parseFromString(spineItem.text, "application/xhtml+xml");

	// load all images: <img> and svg <image>
	for (const elem of epubPageDoc.body.querySelectorAll<HTMLImageElement>(
		'img[src^="epub://"]',
	)) {
		loadImageElement(elem, elem.src.substring(7), base64 => {
			elem.src = `data:${base64}`;
		});
	}
	for (const elem of epubPageDoc.body.querySelectorAll<SVGImageElement>("image")) {
		const href = elem.href.baseVal;
		if (href.startsWith("epub://")) {
			loadImageElement(elem, href.substring(7), base64 => {
				elem.href.baseVal = `data:${base64}`;
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
	for (const elemStyle of epubPageDoc.head.querySelectorAll<HTMLStyleElement>("style")) {
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
	readerShadowRoot!.appendChild(epubPageDoc.body);
	if (scroll != null) {
		elemReaderHost!.scroll({ top: scroll, behavior: "instant" });
	}

	elemSpinePosition!.textContent = `Position: ${spineItem.position}`;
}

function createNavUi(navRoot: EpubNavPoint): void {
	const ol = document.createElement("ol");
	elemTocNav!.replaceChildren(ol);

	ol.append(...navRoot.children.map(createNavPoint));

	elemTocModal!.addEventListener("close", async () => {
		const value = elemTocModal!.returnValue;
		if (value) {
			const [path, locationId] = value.split("#", 2);
			let spineItemData: SpineItemData | null;
			try {
				spineItemData = await rs.moveToInSpine(path);
			} catch (err) {
				console.error(`Error jumping to ${path}:`, err);
				return;
			}
			if (!spineItemData) {
				console.error(`Page not found: ${path}`);
				return;
			}
			await renderBookPage(spineItemData, 0);
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
	rs.openEpub()
		.then(initSpineItem => {
			if (initSpineItem) {
				// got the book.
				(event.target as HTMLElement).remove();
				openEpub(initSpineItem);
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

function refreshUiWithBookMetadata(metadata: EpubMetadata): void {
	if (metadata.language) {
		const lang = metadata.language[0];
		if (lang) {
			elemReaderHost!.lang = lang;
			elemTocNav!.lang = lang;
			elemPreviewDiv!.lang = lang;
		}
	}
	if (metadata.title) {
		const epubTitleDisplay = metadata.title.filter(t => t).join(" · ");
		if (epubTitleDisplay) {
			document.title = `${epubTitleDisplay} - ${APP_NAME}`;
		}
	}
}

function createBookDetailsUi(metadata: EpubMetadata): void {
	elemBookDetailsTable!.replaceChildren(
		...Object.entries(metadata).map(([key, values]) => {
			const tr = document.createElement("tr");
			const th = document.createElement("th");
			const td = document.createElement("td");
			tr.append(th, td);

			th.textContent = key;

			if (values) {
				if (values.length > 1) {
					// use a list
					const ul = document.createElement("ul");
					td.appendChild(ul);
					ul.append(
						...values.map(v => {
							const li = document.createElement("li");
							li.textContent = v;
							return li;
						}),
					);
				} else {
					td.textContent = values[0];
				}
			}

			return tr;
		}),
	);
}

async function initMetadata(): Promise<void> {
	let result: EpubMetadata;
	try {
		result = await rs.getMetadata();
	} catch (err) {
		console.error("Error loading metadata:", err);
		return;
	}

	refreshUiWithBookMetadata(result);
	createBookDetailsUi(result);
}

async function initToc(): Promise<void> {
	let result: EpubNavPoint;
	try {
		result = await rs.getToc();
	} catch (err) {
		console.error("Error loading TOC:", err);
		return;
	}
	createNavUi(result);
}

async function openEpub(spineItem: SpineItemData): Promise<void> {
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
	elemTocButton!.addEventListener("click", () => {
		elemTocModal!.showModal();
	});
	elemDetailsButton!.addEventListener("click", () => {
		elemDetailsModal!.showModal();
	});

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
