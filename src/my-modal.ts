export class MyModal extends HTMLElement {
	#dialog: HTMLDialogElement;

	constructor() {
		super();

		const templ = document.getElementById("og-templ-my-modal") as HTMLTemplateElement;
		const content = templ.content;

		const shadowRoot = this.attachShadow({ mode: "open" });
		shadowRoot.appendChild(content.cloneNode(true));

		this.#dialog = shadowRoot.querySelector("dialog")!;
		const form = this.#dialog.firstElementChild!;

		this.#dialog.addEventListener("click", () => this.close());
		form.addEventListener("click", (e: Event) => e.stopPropagation());
	}

	public show(): void {
		this.#dialog.showModal();
	}

	public close(value?: string): void {
		this.#dialog.close(value);
	}

	public setOnClose(listener: (value: string) => void): any {
		this.#dialog.onclose = () => {
			const value = this.#dialog.returnValue;
			if (value) {
				listener(value);
			}
		};
	}
}

customElements.define("my-modal", MyModal);
