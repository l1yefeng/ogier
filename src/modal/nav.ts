import { BaseModal, ModalCoordinator } from "./base";

import { AboutPub, fetchXml, PubHelper, TaskRepeater } from "../base";
import * as rs from "../invoke";

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

	/**
	 * A button in <nav>. It becomes disabled (because it's where the reader is).
	 */
	#closestNavPoint: HTMLButtonElement | null = null;
	/**
	 * A label outside this modal whose content will be linked to the closest nav point.
	 */
	#externalLabel?: HTMLElement;
	#closestNavPointTask: TaskRepeater = new TaskRepeater(500);

	async init(pub: AboutPub, pubHelper: PubHelper, externalLabel: HTMLElement): Promise<void> {
		this.locked = false;
		const { pubTocUrl: url, pubTocIsLegacy: isLegacy } = pub;
		if (!url) {
			throw new Error("No TOC");
		}
		const doc = await fetchXml(url, false);

		if (isLegacy) {
			makeUiFromNcx(doc, url, this.#nav, this.#title, pubHelper.lang);
		} else {
			makeUiFromNav(doc, url, this.#nav, this.#title, pubHelper.lang);
		}

		this.#externalLabel = externalLabel;
	}

	stopClosestNavPointTask(): void {
		this.#closestNavPointTask.stop();
		this.#unsetClosestNavPoint();
	}

	/**
	 * Should be called whenever the page being read is updated,
	 * i.e., when the `getCurrentOffset` and `getTargetOffset` provided last time no longer applies.
	 *
	 * It has two purposes:
	 * 1. Update NavModal's knowledge of the closest point, so that UI show its distinction.
	 * 2. Update external label to match the closest point.
	 *
	 * @param url Current page URL
	 * @param getCurrentOffset Getting the view offset in the current page
	 * @param getTargetOffset Getting the offset of certain element in the current page
	 */
	restartClosestNavPointTask(
		url: URL,
		getCurrentOffset: () => number,
		getTargetOffset: (id: string) => number | null,
	): void {
		const label = this.#externalLabel;
		if (!label) return;

		// Compute matched buttons here, not in task
		const btns = this.#nav.querySelectorAll<HTMLButtonElement>(
			`button[data-path="${url.pathname}"]`,
		);

		if (btns.length == 0) {
			// shortcut: always default toc label, so don't repeat task
			label.textContent = toc_default_title;
			label.removeAttribute("lang");
			this.#unsetClosestNavPoint();
			return;
		}
		if (btns.length == 1) {
			// shortcut: always the one, so don't repeat task
			const btn = btns[0];
			label.innerHTML = btn.innerHTML;
			label.lang = btn.closest<HTMLElement>("[lang]")!.lang;
			this.#setClosestNavPoint(btn);
			return;
		}

		// the closest nav point will be located according to offsets,
		// and this will be calculated repeatedly.
		const navPoints: [HTMLButtonElement, number][] = Array.from(btns).map(btn => {
			const id = btn.dataset.locationId;
			const offset = id ? (getTargetOffset(id) ?? 0) : 0;
			return [btn, offset];
		});
		navPoints.sort((a, b) => b[1] - a[1]); // offset high to low

		const task = () => {
			const viewOffset = getCurrentOffset();
			const [btn, _offset] =
				navPoints.find(([_btn, offset]) => offset <= viewOffset) ??
				navPoints[navPoints.length - 1];
			label.innerHTML = btn.innerHTML;
			label.lang = btn.closest<HTMLElement>("[lang]")!.lang;
			this.#setClosestNavPoint(btn);
		};
		this.#closestNavPointTask.restart(task);
	}

	#unsetClosestNavPoint() {
		if (this.#closestNavPoint) {
			this.#closestNavPoint.autofocus = false;
			this.#closestNavPoint.disabled = false;
		}
	}
	#setClosestNavPoint(btn: HTMLButtonElement) {
		this.#unsetClosestNavPoint();
		btn.autofocus = true;
		btn.disabled = true;
		this.#closestNavPoint = btn;
	}

	show(): void {
		if (ModalCoordinator.show(this)) {
			this.#closestNavPoint?.scrollIntoView();
		}
	}

	setupTocGoTo(navigate: (url: URL) => any) {
		this.setOnClose(async value => {
			// If there is no hash, locationId is undefined.
			await navigate(URL.parse(value)!);
		});
	}

	private constructor() {
		super(document.getElementById("og-toc-modal") as HTMLDialogElement);
		this.locked = true;
		this.#title = document.getElementById("og-toc-title") as HTMLDivElement;
		this.#nav = document.getElementById("og-toc-nav") as HTMLElement;

		ModalCoordinator.modals["nav"] = this;

		rs.setMenuHandlerFotFileNavigate(() => this.show());
	}

	// Singleton
	private static self?: NavModal;
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
	pubLang: string,
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

	navElem.lang = doc.documentElement.lang || pubLang;
}

function makeUiFromNav(
	doc: Document,
	url: URL,
	navElem: HTMLElement,
	titleElem: HTMLElement,
	pubLang: string,
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

	navElem.lang = nav.lang || doc.documentElement.lang || pubLang;
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
