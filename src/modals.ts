/**
 * Parts of the UI that compose the details modal, TOC modal, and note preview modal.
 */

import { EpubDetails, EpubNavPoint, EpubToc } from "./base";
import { Context } from "./context";
import { toc_default_title } from "./strings.json";

let elemDetailsModal: HTMLDialogElement | null;
let elemDetailsBookDl: HTMLDListElement | null;
let elemDetailsMetadataPre: HTMLPreElement | null;
let elemDetailsFileDl: HTMLDListElement | null;
let elemDetailsCoverImg: HTMLImageElement | null;
let elemTocModal: HTMLDialogElement | null;
let elemTocTitle: HTMLElement | null;
let elemTocNav: HTMLElement | null;
let elemPreviewModal: HTMLDialogElement | null;
let elemPreviewDiv: HTMLDivElement | null;
let elemPreviewGoThereBtn: HTMLButtonElement | null;

export function loadModalsContent(): void {
	elemDetailsModal = document.getElementById("og-details-modal") as HTMLDialogElement;
	elemDetailsBookDl = document.getElementById("og-details-book") as HTMLDListElement;
	elemDetailsMetadataPre = document.getElementById("og-details-metadata") as HTMLPreElement;
	elemDetailsFileDl = document.getElementById("og-details-file") as HTMLDListElement;
	elemDetailsCoverImg = document.getElementById("og-details-cover") as HTMLImageElement;
	elemTocModal = document.getElementById("og-toc-modal") as HTMLDialogElement;
	elemTocTitle = document.getElementById("og-toc-title") as HTMLElement;
	elemTocNav = document.getElementById("og-toc-nav") as HTMLElement;
	elemPreviewModal = document.getElementById("og-preview-modal") as HTMLDialogElement;
	elemPreviewDiv = document.getElementById("og-preview-div") as HTMLDivElement;
	elemPreviewGoThereBtn = document.getElementById("og-preview-go-there") as HTMLButtonElement;

	setupModalClickListener(elemDetailsModal);
	setupModalClickListener(elemTocModal);
	setupModalClickListener(elemPreviewModal);
}

function setupModalClickListener(modal: HTMLDialogElement): void {
	const inner = modal.firstElementChild as HTMLElement;
	modal.addEventListener("click", () => modal.close());
	inner.addEventListener("click", e => e.stopPropagation());
}

export function setModalsLanguage(): void {
	const lang = Context.epubLang;
	if (lang) {
		// If already set, it is perhaps set when creating the nav using its own lang
		if (!elemTocNav!.lang) {
			elemTocNav!.lang = lang;
		}
	}
}

// Details: metadata and book/file properties
//

export function createBookDetailsUi(details: EpubDetails): void {
	if (details.coverBase64) {
		elemDetailsCoverImg!.src = `data:${details.coverBase64}`;
		elemDetailsCoverImg!.nextElementSibling?.remove();
	} else {
		const h = document.createElement("h1");
		h.textContent = details.displayTitle;
		elemDetailsCoverImg!.replaceWith(h);
	}

	elemDetailsBookDl!.replaceChildren(
		...Object.entries(details.metadata).flatMap(([key, values]) =>
			createDetailsDlItem(key, values),
		),
	);

	elemDetailsMetadataPre!.textContent = "TO DO";

	elemDetailsFileDl!.replaceChildren();
	elemDetailsFileDl!.append(...createDetailsDlItem("Path", details.fileInfo.path));
	elemDetailsFileDl!.append(
		...createDetailsDlItem("Size", `${details.fileInfo.size.toLocaleString()} bytes`),
	);
	if (details.fileInfo.created) {
		elemDetailsFileDl!.append(
			...createDetailsDlItem("Created at", timeStringFromMs(details.fileInfo.created)),
		);
	}
	if (details.fileInfo.modified) {
		elemDetailsFileDl!.append(
			...createDetailsDlItem("Modified at", timeStringFromMs(details.fileInfo.modified)),
		);
	}
}

function timeStringFromMs(ms: number): string {
	const date = new Date();
	date.setTime(ms);
	return date.toLocaleString();
}

function createDetailsDlItem(
	prop: string,
	value: string | string[],
): [HTMLElement, HTMLElement] {
	const dt = document.createElement("dt");
	const dd = document.createElement("dd");

	dt.textContent = prop;

	if (value instanceof Array) {
		if (value.length > 1) {
			// use a list
			const ol = document.createElement("ol");
			dd.appendChild(ol);
			ol.append(
				...value.map(v => {
					const li = document.createElement("li");
					li.textContent = v;
					return li;
				}),
			);
		} else {
			dd.textContent = value[0];
		}
	} else {
		dd.textContent = value;
	}

	return [dt, dd];
}

export function showDetails(): void {
	elemTocModal!.close();
	elemPreviewModal!.close();
	elemDetailsModal!.showModal();
}

// Toc
//

function createNavPointNcx(navPoint: EpubNavPoint): HTMLLIElement {
	const elemNavPoint = document.createElement("li");

	const elemNavBtn = document.createElement("button");
	elemNavBtn.textContent = navPoint.label;
	elemNavBtn.value = navPoint.content;
	const [path, locationId] = navPoint.content.split("#", 2);
	elemNavBtn.dataset.path = path;
	elemNavBtn.dataset.locationId = locationId || "";
	elemNavBtn.dataset.playOrder = navPoint.playOrder.toString();
	elemNavPoint.appendChild(elemNavBtn);

	if (navPoint.children.length > 0) {
		const sub = document.createElement("ol");
		sub.append(...navPoint.children.map(createNavPointNcx));
		elemNavPoint.appendChild(sub);
	}

	return elemNavPoint;
}

function remakeNavPoints(ol: HTMLOListElement, navDocPath: string): void {
	for (const child of ol.children) {
		if (child instanceof HTMLLIElement) {
			const label = document.createElement("button");
			label.textContent = "--";
			label.disabled = true;
			let ol: HTMLOListElement | null = null;
			for (const grandChild of child.children) {
				if (grandChild instanceof HTMLSpanElement) {
					label.replaceChildren(...grandChild.childNodes);
					label.disabled = true;
					label.value = "";
					if (grandChild.lang) {
						label.lang = grandChild.lang;
					}
				} else if (grandChild instanceof HTMLAnchorElement) {
					label.replaceChildren(...grandChild.childNodes);
					label.disabled = false;
					// relative path
					let href = grandChild.getAttribute("href") ?? "";
					if (!href.startsWith("/")) {
						const parts = navDocPath.split("/");
						parts.splice(parts.length - 1, 1, href);
						href = parts.join("/");
					}
					label.value = href;
					const [path, locationId] = href.split("#", 2);
					label.dataset.path = path;
					label.dataset.locationId = locationId ?? "";
					if (grandChild.lang) {
						label.lang = grandChild.lang;
					}
				} else if (grandChild instanceof HTMLOListElement) {
					ol = grandChild;
					remakeNavPoints(ol, navDocPath);
				}
			}
			child.replaceChildren();
			child.appendChild(label);
			if (ol) {
				child.appendChild(ol);
			}
		} else {
			child.remove();
		}
	}
}

export function createTocUi(toc: EpubToc): void {
	let ol: HTMLOListElement;
	elemTocTitle!.replaceChildren(toc_default_title);
	let lang;
	if (toc.kind == "ncx") {
		ol = document.createElement("ol");
		ol.append(...toc.root.children.map(createNavPointNcx));
		lang = toc.lang;
	} else {
		const { nav, path } = toc;
		const originalHeading = [...nav.children].find(
			child => child instanceof HTMLHeadingElement,
		);
		if (originalHeading) {
			elemTocTitle!.replaceChildren(...originalHeading.childNodes);
		}
		ol = [...nav.children].find(child => child instanceof HTMLOListElement)!;
		remakeNavPoints(ol, path);
		lang = nav.lang || toc.lang;
	}

	elemTocNav!.replaceChildren(ol);
	elemTocNav!.lang = lang || Context.epubLang;
}

export function setupTocGoTo(navigate: (path: string, locationId?: string) => any) {
	elemTocModal!.onclose = async () => {
		const value = elemTocModal!.returnValue;
		if (value) {
			// If there is no hash, locationId is undefined.
			const [path, locationId] = value.split("#", 2);
			await navigate(path, locationId);
		}
	};
}

let lastMostRecentNavPoint: HTMLButtonElement | null = null;

export function mostRecentNavPoint(
	currentPath: string,
	offset: number,
	getAnchoredOffset: (id: string) => number,
): HTMLButtonElement | null {
	const buttons = elemTocNav!.querySelectorAll<HTMLButtonElement>(
		`button[data-path="${currentPath}"]`,
	);
	if (buttons.length == 0) {
		return null;
	}

	let mostRecent: [number, HTMLButtonElement] | null = null;
	for (const btn of buttons) {
		const anchoredOffset = btn.dataset.locationId
			? getAnchoredOffset(btn.dataset.locationId)
			: 0;
		if (offset >= anchoredOffset) {
			if (mostRecent == null || anchoredOffset >= mostRecent[0]) {
				mostRecent = [anchoredOffset, btn];
			}
		}
	}

	if (mostRecent) {
		const [_, btn] = mostRecent;
		if (lastMostRecentNavPoint) {
			lastMostRecentNavPoint.autofocus = false;
			lastMostRecentNavPoint.disabled = false;
		}
		btn.autofocus = true;
		btn.disabled = true;
		lastMostRecentNavPoint = btn;
		return btn;
	}
	return null;
}

export function showToc(): void {
	elemDetailsModal!.close();
	elemPreviewModal!.close();
	elemTocModal!.showModal();

	lastMostRecentNavPoint?.scrollIntoView();
}

// Note preview
//

export function showNotePreview(floatingContentRoot: HTMLElement): void {
	elemTocModal!.close();
	elemDetailsModal!.close();
	elemPreviewModal!.showModal();

	elemPreviewDiv!.replaceChildren(...floatingContentRoot.childNodes);
	elemPreviewDiv!.lang = Context.spineItemLang || Context.epubLang;
}

export function setupNotePreviewGoThere(navigate: () => any): void {
	elemPreviewModal!.onclose = () => {
		const value = elemPreviewModal!.returnValue;
		if (value) {
			navigate();
		}
	};
}
