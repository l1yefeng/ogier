import { BaseModal, ModalCoordinator } from "./base";

import { Context } from "../context";
import { toc_default_title } from "../strings.json";
import { fetchXml } from "../base";

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

	async init(): Promise<void> {
		this.locked = false;
		const { pubTocUrl: url, pubTocIsLegacy: isLegacy } = Context.getOpenedEpub();
		if (!url) {
			throw new Error("No TOC");
		}
		const doc = await fetchXml(url, false);

		if (isLegacy) {
			makeUiFromNcx(doc, url, this.#nav, this.#title);
		} else {
			makeUiFromNav(doc, url, this.#nav, this.#title);
		}
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
		const lang = Context.getEpubLang();
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

function makeUiFromNcx(
	doc: Document,
	url: URL,
	navElem: HTMLElement,
	titleElem: HTMLElement,
): void {
	// find and set title
	const docTitleElem = doc.querySelector("docTitle");
	if (docTitleElem) {
		titleElem.textContent = docTitleElem.firstElementChild!.textContent!.trim();
	} else {
		titleElem.textContent = toc_default_title;
	}

	// find and convert <navMap>
	const navMap = doc.querySelector("navMap")!;
	const ol = document.createElement("ol");
	for (const navPoint of navMap.children) {
		ol.appendChild(makeUiLiFromNcxNavPoint(navPoint, url));
	}
	navElem.replaceChildren(ol);

	navElem.lang = doc.documentElement.lang || Context.getEpubLang();
}

function makeUiFromNav(
	doc: Document,
	url: URL,
	navElem: HTMLElement,
	titleElem: HTMLElement,
): void {
	// find <nav> in doc
	const nav = doc.querySelector<HTMLElement>("nav:has(>ol)");
	if (!nav) {
		throw new Error("No proper nav in XML");
	}

	// set title
	const originalHeading = [...nav.children].find(child => child instanceof HTMLHeadingElement);
	if (originalHeading) {
		titleElem.replaceChildren(...originalHeading.childNodes);
	} else {
		titleElem.textContent = toc_default_title;
	}

	// convert the navigation list
	const ol = [...nav.children].find(child => child instanceof HTMLOListElement)!;
	makeUiOlFromNavOlInPlace(ol, url);
	navElem.replaceChildren(ol);

	navElem.lang = nav.lang || doc.documentElement.lang || Context.getEpubLang();
}

function makeUiOlFromNavOlInPlace(ol: HTMLOListElement, navDocUrl: URL): void {
	for (const child of ol.children) {
		if (child instanceof HTMLLIElement) {
			const elemNavBtn = document.createElement("button");
			elemNavBtn.textContent = "--";
			elemNavBtn.disabled = true;
			let ol: HTMLOListElement | null = null;
			for (const grandChild of child.children) {
				if (grandChild instanceof HTMLSpanElement) {
					elemNavBtn.replaceChildren(...grandChild.childNodes);
					elemNavBtn.disabled = true;
					elemNavBtn.value = "";
					if (grandChild.lang) {
						elemNavBtn.lang = grandChild.lang;
					}
				} else if (grandChild instanceof HTMLAnchorElement) {
					elemNavBtn.replaceChildren(...grandChild.childNodes);
					elemNavBtn.disabled = false;
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
					elemNavBtn.value = href;
					elemNavBtn.dataset.path = path;
					elemNavBtn.dataset.locationId = locationId;
					if (grandChild.lang) {
						elemNavBtn.lang = grandChild.lang;
					}
				} else if (grandChild instanceof HTMLOListElement) {
					ol = grandChild;
					makeUiOlFromNavOlInPlace(ol, navDocUrl);
				}
			}
			child.replaceChildren();
			child.appendChild(elemNavBtn);
			if (ol) {
				child.appendChild(ol);
			}
		} else {
			child.remove();
		}
	}
}

function makeUiLiFromNcxNavPoint(navPoint: Element, ncxDocUrl: URL): HTMLLIElement {
	const elem = document.createElement("li");

	let text: string | null = null;
	let href: URL | null = null;
	const children = [];
	for (const child of navPoint.children) {
		if (child.tagName == "navLabel") {
			text = child.firstElementChild?.textContent ?? null;
		} else if (child.tagName == "content") {
			href = URL.parse(child.getAttribute("src")!, ncxDocUrl);
		} else if (child.tagName == "navPoint") {
			children.push(child);
		}
	}

	const elemNavBtn = document.createElement("button");
	elemNavBtn.textContent = text || "--";
	if (href) {
		elemNavBtn.disabled = false;
		elemNavBtn.value = href.toString();
		elemNavBtn.dataset.path = href.pathname;
		elemNavBtn.dataset.locationId = href.hash.slice(1);
	} else {
		elemNavBtn.disabled = true;
		elemNavBtn.value = "";
	}
	elem.appendChild(elemNavBtn);

	if (children.length > 0) {
		const sub = document.createElement("ol");
		for (const childElem of children) {
			sub.appendChild(makeUiLiFromNcxNavPoint(childElem, ncxDocUrl));
		}
		elem.appendChild(sub);
	}

	return elem;
}
