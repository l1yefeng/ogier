/**
 * **Internal to the same directory!**
 *
 * To be extended by classes in this directory only.
 * When extending, there should be an `open`, sometimes also an `init`.
 */
export class BaseModal {
	/**
	 * The HTML `<dialog>` element.
	 */
	readonly inner: HTMLDialogElement;

	/**
	 * **Protected field!**
	 *
	 * If this is open and locked, coordinator shouldn't close this or open
	 * another modal; clicking in the backdrop shouldn't close this.
	 *
	 * If this is closed and locked, this should not show.
	 *
	 * If the modal should be initialized before being seen, set to true in
	 * constructor and set to false when initializing.
	 */
	locked = false;

	constructor(element: HTMLDialogElement) {
		this.inner = element;

		const shell = element.firstElementChild as HTMLElement;
		element.addEventListener("click", () => {
			if (!this.locked) element.close();
		});
		shell.addEventListener("click", e => e.stopPropagation());
	}

	protected setOnClose(fn: (value: string) => any): void {
		this.inner.onclose = () => {
			const value = this.inner.returnValue;
			if (value) fn(value);
		};
	}

	/**
	 * **Protected function!**
	 */
	close(): boolean {
		if (!this.inner.open) return true;
		if (this.locked) return false;
		this.inner.close();
		return true;
	}
}

/**
 * **Internal to the same directory!**
 */
export class ModalCoordinator {
	static modals: Record<string, BaseModal> = {};

	static show(modal: BaseModal): boolean {
		if (modal.inner.open) return false;
		if (modal.locked) return false;
		for (const id in ModalCoordinator.modals) {
			const m = ModalCoordinator.modals[id];
			if (modal != m) {
				if (!m.close()) {
					return false;
				}
			}
		}

		modal.inner.showModal();
		return true;
	}
}
