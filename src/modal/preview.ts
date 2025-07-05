import { BaseModal, ModalCoordinator } from "./base";

import { Context } from "../context";

export class PreviewModal extends BaseModal {
	#contentDiv: HTMLElement;

	private constructor() {
		super(document.getElementById("og-preview-modal") as HTMLDialogElement);
		this.#contentDiv = document.getElementById("og-preview-div") as HTMLDivElement;

		ModalCoordinator.modals["preview"] = this;
	}

	show(floatingContentRoot: HTMLElement): void {
		if (ModalCoordinator.show(this)) {
			this.#contentDiv.replaceChildren(...floatingContentRoot.childNodes);
			this.#contentDiv.lang = Context.spineItemLang || Context.getEpubLang();
		}
	}

	setupGoThere(navigate: () => any): void {
		this.setOnClose(_ => navigate());
	}

	// Singleton
	static self?: PreviewModal;
	static get(): PreviewModal {
		if (!PreviewModal.self) PreviewModal.self = new PreviewModal();
		return PreviewModal.self;
	}
}
