import { BaseModal, ModalCoordinator } from "./base";

import { EpubNavPoint, EpubToc } from "../base";
import { Context } from "../context";
import { toc_default_title } from "../strings.json";

/**
 * The central element is a `<nav>` element.
 * Input elements within are buttons, each associated with
 * - value: the target URL
 * - dataset.path: the pathname of that URL (starts with '/')
 * - dataset.locationId: the ID in the hash (no '#')
 */
export class NavModal extends BaseModal {
	#title: HTMLElement;
	#nav: HTMLElement;

	#lastMostRecentNavPoint: HTMLButtonElement | null = null;

	private constructor() {
		super(document.getElementById("og-toc-modal") as HTMLDialogElement);
		this.locked = true;
		this.#title = document.getElementById("og-toc-title") as HTMLDivElement;
		this.#nav = document.getElementById("og-toc-nav") as HTMLElement;

		ModalCoordinator.modals["nav"] = this;
	}

	init(toc: EpubToc): void {
		this.locked = false;
		let ol: HTMLOListElement;
		this.#title.replaceChildren(toc_default_title);
		let lang;
		if (toc.kind == "ncx") {
			if (toc.root.label) {
				this.#title.replaceChildren(toc.root.label);
			}
			ol = document.createElement("ol");
			ol.append(...toc.root.children.map(createNavPointNcx));
			lang = toc.lang;
		} else {
			const { nav, path } = toc;
			const originalHeading = [...nav.children].find(
				child => child instanceof HTMLHeadingElement,
			);
			if (originalHeading) {
				this.#title.replaceChildren(...originalHeading.childNodes);
			}
			ol = [...nav.children].find(child => child instanceof HTMLOListElement)!;
			remakeNavPoints(ol, path);
			lang = nav.lang || toc.lang;
		}

		this.#nav.replaceChildren(ol);
		this.#nav.lang = lang || Context.epubLang;
	}

	show(): void {
		if (ModalCoordinator.show(this)) {
			this.#lastMostRecentNavPoint?.scrollIntoView();
		}
	}

	setupTocGoTo(navigate: (url: URL) => any) {
		this.setOnClose(async value => {
			// If there is no hash, locationId is undefined.
			await navigate(URL.parse(value)!);
		});
	}

	mostRecentNavPoint(
		currentPath: string,
		offset: number,
		getAnchoredOffset: (id: string) => number,
	): HTMLButtonElement | null {
		const buttons = this.#nav.querySelectorAll<HTMLButtonElement>(
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

	onContextLangChange(): void {
		const lang = Context.epubLang;
		if (lang) {
			// If already set, it is perhaps set when creating the nav using its own lang
			if (!this.#nav.lang) {
				this.#nav.lang = lang;
			}
		}
	}

	// Singleton
	static self?: NavModal;
	static get(): NavModal {
		if (!NavModal.self) NavModal.self = new NavModal();
		return NavModal.self;
	}
}

function remakeNavPoints(ol: HTMLOListElement, navDocUrl: URL): void {
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
					let path = "";
					let locationId = "";
					if (href) {
						const url = URL.parse(href, navDocUrl);
						if (url) {
							href = url.toString();
							path = url.pathname;
							locationId = url.hash.slice(1); // empty if hash is empty
						}
					}
					label.value = href;
					label.dataset.path = path;
					label.dataset.locationId = locationId;
					if (grandChild.lang) {
						label.lang = grandChild.lang;
					}
				} else if (grandChild instanceof HTMLOListElement) {
					ol = grandChild;
					remakeNavPoints(ol, navDocUrl);
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

// TODO: this is wrong but should be unreachable. delete when it's time.
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
