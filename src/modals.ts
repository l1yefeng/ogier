/**
 * Parts of the UI that compose the details modal, TOC modal, and note preview modal.
 *
 * See class Modal, which is extended by each of the three types of modals.
 */

import { EpubDetails, EpubNavPoint, EpubToc } from "./base";

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

export enum ModalType {
	Details,
	Toc,
	Preview,
}

type ModalTypeMap = {
	[ModalType.Details]: DetailsModal;
	[ModalType.Toc]: TocModal;
	[ModalType.Preview]: PreviewModal;
};

/**
 * Modal is the base class not to be constructed directly, but extended by three subclasses.
 *
 * It has a second purpose, to serve as a manager of the modals.
 * Static method Modal.get is used to obtain a modal.
 */
export class Modal {
	protected dialog: HTMLDialogElement;

	protected constructor(dialogId: string) {
		this.dialog = document.getElementById(dialogId) as HTMLDialogElement;

		const form = this.dialog.firstElementChild as HTMLFormElement;
		this.dialog.addEventListener("click", () => this.dialog.close());
		form.addEventListener("click", e => e.stopPropagation());
	}

	protected set onclose(fn: (value: string) => any) {
		this.dialog.onclose = () => {
			const value = this.dialog.returnValue;
			if (value) {
				fn(value);
			}
		};
	}

	protected get type(): ModalType {
		throw new Error("Override this");
	}

	protected static showOnly(modal: Modal): void {
		Modal.instances.forEach((instance: Modal | null) => {
			if (instance && instance != modal) {
				instance.dialog.close();
			}
		});
		modal.dialog.showModal();
	}

	protected static instances: [DetailsModal | null, TocModal | null, PreviewModal | null] = [
		null,
		null,
		null,
	];
	static get<T extends ModalType>(typ: T): ModalTypeMap[T] {
		if (typ == ModalType.Preview && Modal.instances[typ] == null) {
			new PreviewModal();
		}
		return Modal.instances[typ] as ModalTypeMap[T];
	}
}

export class DetailsModal extends Modal {
	#elemBookDl: HTMLDListElement;
	#elemMetadataPre: HTMLPreElement;
	#elemFileDl: HTMLDListElement;
	#elemCoverImg: HTMLImageElement;

	constructor(details: EpubDetails) {
		super("og-details-modal");
		Modal.instances[ModalType.Details] = this;

		this.#elemBookDl = document.getElementById("og-details-book") as HTMLDListElement;
		this.#elemMetadataPre = document.getElementById("og-details-metadata") as HTMLPreElement;
		this.#elemFileDl = document.getElementById("og-details-file") as HTMLDListElement;
		this.#elemCoverImg = document.getElementById("og-details-cover") as HTMLImageElement;

		this.#createUi(details);
	}

	#createUi(details: EpubDetails): void {
		if (details.coverBase64) {
			this.#elemCoverImg.src = `data:${details.coverBase64}`;
			this.#elemCoverImg.nextElementSibling?.remove();
		} else {
			const h = document.createElement("h1");
			h.textContent = details.displayTitle;
			this.#elemCoverImg.replaceWith(h);
		}

		this.#elemBookDl.replaceChildren(
			...Object.entries(details.metadata).flatMap(([key, values]) =>
				createDetailsDlItem(key, values),
			),
		);

		this.#elemMetadataPre.textContent = "TO DO";

		this.#elemFileDl.replaceChildren();
		this.#elemFileDl.append(...createDetailsDlItem("Path", details.fileInfo.path));
		this.#elemFileDl.append(
			...createDetailsDlItem("Size", `${details.fileInfo.size.toLocaleString()} bytes`),
		);
		if (details.fileInfo.created) {
			this.#elemFileDl.append(
				...createDetailsDlItem("Created at", timeStringFromMs(details.fileInfo.created)),
			);
		}
		if (details.fileInfo.modified) {
			this.#elemFileDl.append(
				...createDetailsDlItem("Modified at", timeStringFromMs(details.fileInfo.modified)),
			);
		}
	}

	show(): void {
		Modal.showOnly(this);
	}

	get type(): ModalType {
		return ModalType.Details;
	}
}

export class TocModal extends Modal {
	#elemHeading: HTMLElement;
	#elemNav: HTMLElement;
	#lastMostRecentNavPoint: HTMLButtonElement | null = null;

	constructor(toc: EpubToc) {
		super("og-toc-modal");
		Modal.instances[ModalType.Toc] = this;

		this.#elemHeading = document.getElementById("og-toc-heading") as HTMLElement;
		this.#elemNav = document.getElementById("og-toc-nav") as HTMLElement;

		this.#createUi(toc);
	}

	#createUi(toc: EpubToc): void {
		let ol: HTMLOListElement;
		if (toc.kind == "ncx") {
			this.#elemHeading.textContent = "Table of Contents";
			ol = document.createElement("ol");
			ol.append(...toc.root.children.map(createNavPointNcx));
		} else {
			const { nav, path } = toc;
			const originalHeading = [...nav.children].find(
				child => child instanceof HTMLHeadingElement,
			);
			if (originalHeading) {
				this.#elemHeading.replaceChildren(...originalHeading.childNodes);
			} else {
				this.#elemHeading.textContent = "Table of Contents";
			}
			ol = [...nav.children].find(child => child instanceof HTMLOListElement)!;
			remakeNavPoints(ol, path);
		}

		this.#elemNav.replaceChildren(ol);
	}

	set onclose(listener: (path: string, locationId?: string) => any) {
		super.onclose = value => {
			// If there is no hash, locationId is undefined.
			const [path, locationId] = value.split("#", 2);
			listener(path, locationId);
		};
	}

	show(): void {
		Modal.showOnly(this);
		this.#lastMostRecentNavPoint?.scrollIntoView();
	}

	mostRecentNavPoint(
		currentPath: string,
		offset: number,
		getAnchoredOffset: (id: string) => number,
	): HTMLButtonElement | null {
		const buttons = this.#elemNav.querySelectorAll<HTMLButtonElement>(
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
			if (this.#lastMostRecentNavPoint) {
				this.#lastMostRecentNavPoint.autofocus = false;
				this.#lastMostRecentNavPoint.disabled = false;
			}
			btn.autofocus = true;
			btn.disabled = true;
			this.#lastMostRecentNavPoint = btn;
			return btn;
		}
		return null;
	}

	get type(): ModalType {
		return ModalType.Toc;
	}
}

export class PreviewModal extends Modal {
	#elemDiv: HTMLDivElement;
	#elemGoThereBtn: HTMLButtonElement;

	constructor() {
		super("og-preview-modal");
		Modal.instances[ModalType.Preview] = this;

		this.#elemDiv = document.getElementById("og-preview-div") as HTMLDivElement;
		this.#elemGoThereBtn = document.getElementById("og-preview-go-there") as HTMLButtonElement;
	}

	show(floatingContentRoot: HTMLElement, noteId: string): void {
		Modal.showOnly(this);
		this.#elemDiv.replaceChildren(...floatingContentRoot.childNodes);
		this.#elemGoThereBtn.value = noteId;
	}

	set onclose(listener: (targetId: string) => any) {
		super.onclose = listener;
	}

	get type(): ModalType {
		return ModalType.Preview;
	}
}

export function showDetails(): void {
	Modal.get(ModalType.Details).show();
}

export function showToc(): void {
	Modal.get(ModalType.Toc).show();
}
