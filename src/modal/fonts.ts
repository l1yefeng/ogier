import { BaseModal, ModalCoordinator } from "./base";

import { Context } from "../context";
import { FontPrefer } from "../base";
import { Store } from "@tauri-apps/plugin-store";

export class FontsModal extends BaseModal {
	#form: HTMLFormElement;
	#substEditor: HTMLDivElement;
	#confirmBtn: HTMLButtonElement;

	private constructor() {
		super(document.getElementById("og-fonts-modal") as HTMLDialogElement);
		this.#form = this.inner.firstElementChild as HTMLFormElement;
		this.#substEditor = document.getElementById("og-fonts-subst-editor") as HTMLDivElement;
		this.#confirmBtn = document.getElementById("og-fonts-subst-confirm") as HTMLButtonElement;

		ModalCoordinator.modals["fonts"] = this;
	}

	show(): void {
		if (!ModalCoordinator.show(this)) return;

		// Start with current prefs
		const prefs = Context.prefsStore;
		if (!prefs) return;
		this.#initFontPrefers(prefs);
		this.#initFontSubsts(prefs);
	}

	async #initFontPrefers(prefs: Store): Promise<void> {
		const prefers = await prefs.get<FontPrefer>("font.prefer");
		const [sans, serif, original] = this.#form.querySelectorAll<HTMLInputElement>(
			'input[name="og-font-prefers"]',
		);
		if (prefers == "sans-serif") {
			sans.checked = true;
		} else if (prefers == "serif") {
			serif.checked = true;
		} else {
			original.checked = true;
		}
	}

	async #initFontSubsts(prefs: Store): Promise<void> {
		const substs = await prefs.get<Record<string, string>>("font.substitute");
		this.#substEditor.replaceChildren();
		if (substs) {
			for (const key in substs) {
				this.#substEditor.appendChild(this.#createFontSubstRuleElem(key, substs[key]));
			}
		}
	}

	#createFontSubstRuleElem(key: string, value: string): HTMLElement {
		const keyInput = document.createElement("input");
		keyInput.value = key;
		const valueInput = document.createElement("input");
		valueInput.value = value;

		const row = document.createElement("div");
		const symbol = document.createElement("span");
		symbol.textContent = "⇒";
		row.append(keyInput, symbol, valueInput);
		return row;
	}

	// Singleton
	static self?: FontsModal;
	static get(): FontsModal {
		if (!FontsModal.self) FontsModal.self = new FontsModal();
		return FontsModal.self;
	}
}
