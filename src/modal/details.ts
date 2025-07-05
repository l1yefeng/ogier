import { BaseModal, ModalCoordinator } from "./base";

import { Context } from "../context";
import { EpubMetadataItem } from "../base";
import { convertFileSrc } from "@tauri-apps/api/core";

export class DetailsModal extends BaseModal {
	#bookDl: HTMLDListElement;
	#fileDl: HTMLDListElement;
	#coverImg: HTMLImageElement;

	private constructor() {
		super(document.getElementById("og-details-modal") as HTMLDialogElement);
		this.locked = true;
		this.#bookDl = document.getElementById("og-details-book") as HTMLDListElement;
		this.#fileDl = document.getElementById("og-details-file") as HTMLDListElement;
		this.#coverImg = document.getElementById("og-details-cover") as HTMLImageElement;

		ModalCoordinator.modals["details"] = this;
	}

	init(): void {
		this.locked = false;
		const about = Context.openedEpub!;
		if (about.pubCoverUrl) {
			// TODO move to utils because it is copied from lib.ts
			this.#coverImg.src = convertFileSrc(about.pubCoverUrl.pathname.slice(1), "epub");
			this.#coverImg.nextElementSibling?.remove();
		} else {
			const h = document.createElement("h1");
			// TODO: extract to utils and fallback to filename
			h.textContent =
				about.pubMetadata.find(item => item.property == "title")?.value ?? "Untitled";
			this.#coverImg.replaceWith(h);
		}

		this.#bookDl.replaceChildren(...about.pubMetadata.flatMap(createDetailsDlItemRich));

		this.#fileDl.replaceChildren();
		this.#fileDl.append(...createDetailsDlItem("Path", about.filePath));
		this.#fileDl.append(
			...createDetailsDlItem("Size", `${about.fileSize.toLocaleString()} bytes`),
		);
		if (about.fileCreated) {
			this.#fileDl.append(
				...createDetailsDlItem("Created at", about.fileCreated.toLocaleString()),
			);
		}
		if (about.fileModified) {
			this.#fileDl.append(
				...createDetailsDlItem("Modified at", about.fileModified.toLocaleString()),
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
	} else if (Context.getEpubLang()) {
		if (
			["contributor", "creator", "description", "publisher", "title"].includes(data.property)
		) {
			dd.lang = Context.getEpubLang();
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
