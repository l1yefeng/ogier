import {
	fetchXml,
	FilewiseStyles,
	getCurrentPosition,
	getCurrentPositionInverse,
	getCurrentPositionPx,
	markSessionInProgress,
	setElementUrl,
	TaskRepeater,
} from "./base";
import { activateCustomizationInput, commitCustomStylesFromSaved } from "./custom";
import * as rs from "./invoke";
import { Styler } from "./styler";

/**
 * Group of components in DOM owned by Reader.
 */
class ReaderDomContext {
	readonly host: HTMLElement;
	readonly shadowRoot: ShadowRoot;
	#clickEventHandler: ((event: Event) => any) | null = null;

	get body(): HTMLElement {
		return this.shadowRoot.querySelector("body")!;
	}

	constructor() {
		this.host = document.getElementById("og-reader-host") as HTMLDivElement;
		this.shadowRoot = this.host.attachShadow({ mode: "open" });
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
		// Remove every existing thing
		this.domContext.shadowRoot.replaceChildren();

		const doc = await fetchXml(url, true);
		this.pageLang = doc.documentElement.lang;
		this.domContext.host.lang = this.pageLang || pubLang;

		await this.processStyles(doc.head, url);
		const body = doc.body;
		this.processImages(body, url);
		this.processAnchors(body, url);

		this.domContext.shadowRoot.appendChild(body);
		if (typeof percentageOrId == "string") {
			this.domContext.shadowRoot.getElementById(percentageOrId)?.scrollIntoView();
		} else if (percentageOrId) {
			const top = getCurrentPositionInverse(
				this.domContext.host.getBoundingClientRect(),
				body.getBoundingClientRect(),
				percentageOrId,
			);
			this.domContext.host.scroll({ top, behavior: "instant" });
		}

		this.saveReadingProgressTask.restart(() => {
			const percentage = this.calculatePercentage();
			return rs.setReadingPosition(url, percentage);
		});

		markSessionInProgress();
	}

	async processStyles(head: HTMLHeadElement, pageUrl: URL): Promise<void> {
		for (const elemLink of head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
			const href = elemLink.getAttribute("href");
			if (!href) continue;
			const url = URL.parse(href, pageUrl);
			if (url) {
				setElementUrl(elemLink, url);
				this.domContext.shadowRoot.appendChild(elemLink);
			}
		}

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

		let filewiseStyles: Partial<FilewiseStyles>;
		try {
			filewiseStyles = (await rs.getFilewiseStyles()) || {};
		} catch (err) {
			console.error("Error loading saved filewise styles:", err);
			filewiseStyles = {};
		}
		const localStylesCommit = (styles: FilewiseStyles) => (this.styler.filewiseStyles = styles);
		commitCustomStylesFromSaved(filewiseStyles, localStylesCommit);
		activateCustomizationInput(localStylesCommit, rs.setFilewiseStyles);
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
		const hostRect = this.domContext.host.getBoundingClientRect();
		const bodyRect = this.domContext.body.getBoundingClientRect();
		return getCurrentPosition(hostRect, bodyRect);
	}

	calculateOffsetPx(): number {
		const hostRect = this.domContext.host.getBoundingClientRect();
		const bodyRect = this.domContext.body.getBoundingClientRect();
		return getCurrentPositionPx(hostRect, bodyRect);
	}

	calculateTargetOffsetPx(id: string): number | null {
		const target = this.domContext.shadowRoot.getElementById(id);
		if (target == null) return null;
		const bodyRect = this.domContext.body.getBoundingClientRect();
		return target.getBoundingClientRect().top - bodyRect.top;
	}

	getElementById(id: string): HTMLElement | null {
		return this.domContext.shadowRoot.getElementById(id);
	}

	// Singleton
	private constructor() {
		this.domContext = new ReaderDomContext();
		this.saveReadingProgressTask = new TaskRepeater(2000);
		this.styler = new Styler(this.domContext.shadowRoot);
	}
	static self?: Reader;
	static get(): Reader {
		if (Reader.self == undefined) {
			Reader.self = new Reader();
		}
		return Reader.self;
	}
}
