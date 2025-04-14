/**
 * Parts of the UI that compose the details modal, TOC modal, and note preview modal.
 */

import { EpubDetails, EpubNavPoint } from "./base";

let elemDetailsModal: HTMLDialogElement | null;
let elemBookDetailsTable: HTMLTableElement | null;
let elemFileDetailsTable: HTMLTableElement | null;
let elemDetailsCoverImg: HTMLImageElement | null;
let elemTocModal: HTMLDialogElement | null;
let elemTocNav: HTMLElement | null;
let elemPreviewModal: HTMLDialogElement | null;
let elemPreviewDiv: HTMLDivElement | null;

export function loadModalsContent(): void {
	elemDetailsModal = document.getElementById("og-details-modal") as HTMLDialogElement;
	elemBookDetailsTable = document.getElementById("og-book-details") as HTMLTableElement;
	elemDetailsCoverImg = document.getElementById("og-details-cover") as HTMLImageElement;
	elemFileDetailsTable = document.getElementById("og-file-details") as HTMLTableElement;
	elemTocModal = document.getElementById("og-toc-modal") as HTMLDialogElement;
	elemTocNav = document.getElementById("og-toc-nav") as HTMLElement;
	elemPreviewModal = document.getElementById("og-preview-modal") as HTMLDialogElement;
	elemPreviewDiv = document.getElementById("og-preview-div") as HTMLDivElement;
}

export function setModalsLanguage(lang: string): void {
	elemTocNav!.lang = lang;
	elemPreviewDiv!.lang = lang;
}

export function getModalsLanguage(): string {
	return elemTocNav!.lang;
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

	elemBookDetailsTable!.replaceChildren(
		...Object.entries(details.metadata).map(([key, values]) =>
			createDetailsTableRow(key, values),
		),
	);

	elemFileDetailsTable!.replaceChildren(
		createDetailsTableRow("Path", details.fileInfo.path),
		createDetailsTableRow("Size", `${details.fileInfo.size.toLocaleString()} bytes`),
	);
	if (details.fileInfo.created) {
		elemFileDetailsTable!.appendChild(
			createDetailsTableRow("Created at", timeStringFromMs(details.fileInfo.created)),
		);
	}
	if (details.fileInfo.modified) {
		elemFileDetailsTable!.appendChild(
			createDetailsTableRow("Modified at", timeStringFromMs(details.fileInfo.modified)),
		);
	}
}

function timeStringFromMs(ms: number): string {
	const date = new Date();
	date.setTime(ms);
	return date.toLocaleString();
}

function createDetailsTableRow(prop: string, value: string | string[]): HTMLTableRowElement {
	const tr = document.createElement("tr");
	const th = document.createElement("th");
	const td = document.createElement("td");
	tr.append(th, td);

	th.textContent = prop;

	if (value instanceof Array) {
		if (value.length > 1) {
			// use a list
			const ol = document.createElement("ol");
			td.appendChild(ol);
			ol.append(
				...value.map(v => {
					const li = document.createElement("li");
					li.textContent = v;
					return li;
				}),
			);
		} else {
			td.textContent = value[0];
		}
	} else {
		td.textContent = value;
	}

	return tr;
}

export function showDetails(): void {
	elemDetailsModal!.showModal();
}

// Toc
//

function createNavPoint(navPoint: EpubNavPoint): HTMLLIElement {
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
		sub.append(...navPoint.children.map(createNavPoint));
		elemNavPoint.appendChild(sub);
	}

	return elemNavPoint;
}

export function createTocUi(
	navRoot: EpubNavPoint,
	navigateTo: (path: string, locationId?: string) => Promise<void>,
): void {
	const ol = document.createElement("ol");
	elemTocNav!.replaceChildren(ol);

	ol.append(...navRoot.children.map(createNavPoint));

	elemTocModal!.addEventListener("close", async () => {
		const value = elemTocModal!.returnValue;
		if (value) {
			// If there is no hash, locationId is undefined.
			const [path, locationId] = value.split("#", 2);
			await navigateTo(path, locationId);
		}
	});
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
	elemTocModal!.showModal();
	lastMostRecentNavPoint?.scrollIntoView();
}

// Note preview
//

export function showNotePreview(floatingContentRoot: HTMLElement): void {
	elemPreviewDiv!.replaceChildren(...floatingContentRoot.childNodes);
	elemPreviewModal!.showModal();
}
