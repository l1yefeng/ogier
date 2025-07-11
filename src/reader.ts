import {
	fetchXml,
	FilewiseStyles,
	markSessionInProgress,
	setElementUrl,
	TaskRepeater,
} from "./base";
import { FilewiseStylesEditor } from "./filewise";
import * as rs from "./invoke";
import { Styler } from "./styler";

class ReaderDomContext {
	#host: HTMLElement;
	readonly shadowRoot: ShadowRoot;
	#clickEventHandler: ((event: Event) => any) | null = null;

	constructor() {
		this.#host = document.getElementById("og-reader-host") as HTMLDivElement;
		this.shadowRoot = this.#host.attachShadow({ mode: "open" });
	}

	get #body(): HTMLElement {
		return this.shadowRoot.querySelector("body")!;
	}
	get #hostRect(): DOMRect {
		return this.#host.getBoundingClientRect();
	}
	get #contentRect(): DOMRect {
		return this.#body.getBoundingClientRect();
	}

	getViewPercentage(): number {
		const box = this.#hostRect;
		const content = this.#contentRect;
		return (box.height / 5 - content.top) / content.height;
	}
	getViewOffsetPx(): number {
		const box = this.#hostRect;
		const content = this.#contentRect;
		return box.height / 5 - content.top;
	}
	getViewOffsetPxFromPercentage(percentage: number): number {
		const box = this.#hostRect;
		const content = this.#contentRect;
		return percentage * content.height - box.height / 5;
	}

	getElement(id: string): HTMLElement | null {
		return this.shadowRoot.getElementById(id);
	}

	getElementOffsetPx(id: string): number | null {
		const target = this.getElement(id);
		if (target == null) return null;
		return target.getBoundingClientRect().top - this.#contentRect.top;
	}

	scrollToElement(id: string): void {
		this.getElement(id)?.scrollIntoView();
	}

	scrollToPercentage(percentage: number): void {
		const top = this.getViewOffsetPxFromPercentage(percentage);
		this.#host.scroll({ top, behavior: "instant" });
	}

	resetContent(): void {
		this.shadowRoot.replaceChildren();
	}
	append(element: HTMLElement): void {
		this.shadowRoot.appendChild(element);
	}

	set lang(value: string) {
		this.#host.lang = value;
	}

	set handleClickEvent(listener: ((event: Event) => any) | null) {
		if (this.#clickEventHandler != null) {
			this.shadowRoot.removeEventListener("click", this.#clickEventHandler);
		}

		if (listener != null) {
			this.shadowRoot.addEventListener("click", listener);
		}
		this.#clickEventHandler = listener;
	}
}

/**
 * Responsibility lies within host's shadow root.
 * In fact, this class doesn't need to know what EPUB is being read.
 * Its job is to show the given page.
 */
export class Reader {
	domContext: ReaderDomContext;
	saveReadingProgressTask: TaskRepeater;
	styler: Styler;
	pageLang: string = "";

	async open(url: URL, percentageOrId: number | string | null, pubLang: string): Promise<void> {
		this.domContext.resetContent();

		const doc = await fetchXml(url, true);
		this.pageLang = doc.documentElement.lang;
		this.domContext.lang = this.pageLang || pubLang;

		await this.processStyles(doc.head, url);
		const body = doc.body;
		this.processImages(body, url);
		this.processAnchors(body, url);

		this.domContext.append(body);
		if (typeof percentageOrId == "string") {
			this.domContext.scrollToElement(percentageOrId);
		} else if (percentageOrId) {
			this.domContext.scrollToPercentage(percentageOrId);
		}

		this.saveReadingProgressTask.restart(() => {
			const percentage = this.calculatePercentage();
			return rs.setReadingPosition(url, percentage);
		});

		markSessionInProgress();
	}

	async processStyles(head: HTMLHeadElement, pageUrl: URL): Promise<void> {
		// links are inserted to shadow DOM.
		for (const elemLink of head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
			const href = elemLink.getAttribute("href");
			if (!href) continue;
			const url = URL.parse(href, pageUrl);
			if (url) {
				setElementUrl(elemLink, url);
				this.domContext.append(elemLink);
			}
		}

		// styler handles css in <style>s
		let cssInPage = "";
		for (const elemStyle of head.querySelectorAll<HTMLStyleElement>("style")) {
			const css = elemStyle.textContent;
			if (css) {
				cssInPage += css;
			}
		}
		this.styler.setStyleElemsCss(cssInPage);

		// TODO(opt) can be parallel?
		await this.styler.loadAppPrefs();

		// styler handles filewise styles
		let filewiseStyles: Partial<FilewiseStyles>;
		try {
			filewiseStyles = (await rs.getFilewiseStyles()) || {};
		} catch (err) {
			console.error("Error loading saved filewise styles:", err);
			filewiseStyles = {};
		}
		const commit = (styles: FilewiseStyles) => (this.styler.filewiseStyles = styles);
		FilewiseStylesEditor.get().commitFromFile(filewiseStyles, commit);
		FilewiseStylesEditor.get().setHandleChange(commit, rs.setFilewiseStyles);
	}

	processImages(body: HTMLElement, pageUrl: URL): void {
		// load all images: <img> and svg <image>
		for (const elem of body.querySelectorAll<HTMLImageElement>("img")) {
			const url = URL.parse(elem.src, pageUrl);
			if (url) {
				setElementUrl(elem, url);
			}
		}
		for (const elem of body.querySelectorAll<SVGImageElement>("image")) {
			const url = URL.parse(elem.href.baseVal, pageUrl);
			if (url) {
				setElementUrl(elem, url);
			}
		}
	}

	processAnchors(body: HTMLElement, pageUrl: URL): void {
		for (const elem of body.querySelectorAll<HTMLAnchorElement>("a")) {
			const href = elem.getAttribute("href");
			if (!href) continue;
			const url = URL.parse(href, pageUrl);
			if (url) {
				if (url.hash) {
					elem.href = url.hash;
				} else {
					setElementUrl(elem, url);
				}
			}
		}
	}

	calculatePercentage(): number {
		return this.domContext.getViewPercentage();
	}

	calculateOffsetPx(): number {
		return this.domContext.getViewOffsetPx();
	}

	calculateTargetOffsetPx(id: string): number | null {
		return this.domContext.getElementOffsetPx(id);
	}

	getElementById(id: string): HTMLElement | null {
		return this.domContext.getElement(id);
	}

	private constructor() {
		this.domContext = new ReaderDomContext();
		this.saveReadingProgressTask = new TaskRepeater(2000);
		this.styler = new Styler(this.domContext.shadowRoot);

		rs.setMenuHandlerForViewFontPrefers(() => {
			this.styler.loadAppPrefs();
		});
	}

	// Singleton
	private static self?: Reader;
	static get(): Reader {
		if (!Reader.self) Reader.self = new Reader();
		return Reader.self;
	}
}
