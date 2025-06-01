import { BaseModal, ModalCoordinator } from "./base";

import { Context } from "../context";
import { EpubDetails, EpubMetadataItem } from "../base";

export class DetailsModal extends BaseModal {
	#bookDl: HTMLDListElement;
	#metadataPre: HTMLPreElement;
	#fileDl: HTMLDListElement;
	#coverImg: HTMLImageElement;

	private constructor() {
		super(document.getElementById("og-details-modal") as HTMLDialogElement);
		this.locked = true;
		this.#bookDl = document.getElementById("og-details-book") as HTMLDListElement;
		this.#metadataPre = document.getElementById("og-details-metadata") as HTMLPreElement;
		this.#fileDl = document.getElementById("og-details-file") as HTMLDListElement;
		this.#coverImg = document.getElementById("og-details-cover") as HTMLImageElement;

		ModalCoordinator.modals["details"] = this;
	}

	init(details: EpubDetails): void {
		this.locked = false;
		if (details.coverBase64) {
			this.#coverImg.src = `data:${details.coverBase64}`;
			this.#coverImg.nextElementSibling?.remove();
		} else {
			const h = document.createElement("h1");
			h.textContent = details.displayTitle;
			this.#coverImg.replaceWith(h);
		}

		this.#bookDl.replaceChildren(...details.metadata.flatMap(createDetailsDlItemRich));

		this.#metadataPre.textContent = "TO DO";

		this.#fileDl.replaceChildren();
		this.#fileDl.append(...createDetailsDlItem("Path", details.fileInfo.path));
		this.#fileDl.append(
			...createDetailsDlItem("Size", `${details.fileInfo.size.toLocaleString()} bytes`),
		);
		if (details.fileInfo.created) {
			this.#fileDl.append(
				...createDetailsDlItem("Created at", timeStringFromMs(details.fileInfo.created)),
			);
		}
		if (details.fileInfo.modified) {
			this.#fileDl.append(
				...createDetailsDlItem("Modified at", timeStringFromMs(details.fileInfo.modified)),
			);
		}
	}

	show(): void {
		ModalCoordinator.show(this);
	}

	// Singleton
	static self?: DetailsModal;
	static get(): DetailsModal {
		if (!DetailsModal.self) DetailsModal.self = new DetailsModal();
		return DetailsModal.self;
	}
}

function timeStringFromMs(ms: number): string {
	const date = new Date();
	date.setTime(ms);
	return date.toLocaleString();
}

function createDetailsDlItemRich(data: EpubMetadataItem): HTMLElement[] {
	const dt = document.createElement("dt");
	const dd = document.createElement("dd");

	// dt
	const pp = data.property.split(":");
	if (pp.length > 1 && pp[0] == "dcterms") {
		pp.shift();
	}
	if (pp.length != 1 && pp.length != 2) {
		return [];
	}
	if (pp.length == 1 && pp[0] == "cover") {
		// TODO: better to know that it's EPUB2 XHTML1.1 <meta>
		return [];
	}
	let titleHtml = `<span class="og-capitalize">${pp[pp.length - 1]}</span>`;
	if (pp.length == 1) {
		if (pp[0] == "language" || pp[0] == "identifier") {
			dd.classList.add("og-details-mono-font");
		}
	} else {
		titleHtml += ` <sup><code>\\${pp[0]}</code></sup>`;
	}
	dt.innerHTML = titleHtml;

	// dd
	if (data.lang) {
		dd.lang = data.lang;
	} else if (Context.epubLang) {
		if (
			["contributor", "creator", "description", "publisher", "title"].includes(data.property)
		) {
			dd.lang = Context.epubLang;
		}
	}
	dd.innerHTML = data.value;
	for (const refine of data.refined) {
		const chip = document.createElement("code");
		chip.classList.add("og-details-refinement");
		chip.textContent = refine.property;
		chip.title = refine.value;
		if (refine.scheme) {
			chip.title += ` - ${refine.scheme}`;
		}
		dt.append(" ", chip);
	}

	return [dt, dd];
}

function createDetailsDlItem(property: string, value: string): [HTMLElement, HTMLElement] {
	const dt = document.createElement("dt");
	const dd = document.createElement("dd");
	dt.textContent = property;
	dd.textContent = value;
	return [dt, dd];
}
