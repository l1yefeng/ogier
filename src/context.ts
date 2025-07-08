import { Store } from "@tauri-apps/plugin-store";

import { AboutPub } from "./base";

type UrlAndPercentage = [URL, number | null];

export class ReaderContext {
	/**
	 * Opened EPUB's (static) info.
	 */
	readonly about: AboutPub;
	readonly epubLang: string;
	readonly epubTitle: string;

	/**
	 * A mapping from URL to its index in spine.
	 * NOTE: URL in spine ==> URL is of a content document.
	 */
	#spineIndexLazy: Map<string, number> | null = null;

	/**
	 * Jumping history and currently reading page.
	 */
	#jumpNavHistory: UrlAndPercentage[] = [];
	#currentPosition: UrlAndPercentage;

	spineItemLang = "";

	constructor(about: AboutPub, startPosition: UrlAndPercentage) {
		this.about = about;

		this.epubLang = about.pubMetadata.find(item => item.property == "language")?.value ?? "";

		let title = about.pubMetadata.find(item => item.property == "title")?.value;
		if (!title) {
			const path = about.filePath;
			const i = path.lastIndexOf("/");
			const j = path.lastIndexOf("\\");
			title = path.slice((i > j ? i : j) + 1);
		}
		this.epubTitle = title;

		this.#currentPosition = startPosition;
	}

	private get spineIndex(): Map<string, number> {
		if (this.#spineIndexLazy == null) {
			const m = new Map<string, number>();
			this.about.pubSpine.forEach((url, index) => {
				m.set(url.pathname, index);
			});
			this.#spineIndexLazy = m;
		}
		return this.#spineIndexLazy;
	}

	updateReadingPosition(position: UrlAndPercentage, pushToHistory: boolean): void {
		if (pushToHistory) {
			this.#jumpNavHistory.push(this.#currentPosition);
		}
		this.#currentPosition = position;
	}

	get readingPosition(): URL {
		return this.#currentPosition[0];
	}
	get readingPositionInSpine(): number | undefined {
		const url = this.readingPosition;
		return this.spineIndex.get(url.pathname);
	}
}

export class GlobalContext {
	readerContext?: ReaderContext;
	prefsStore?: Store;

	private constructor() {}

	// Singleton
	static self?: GlobalContext;
	static get(): GlobalContext {
		if (!GlobalContext.self) GlobalContext.self = new GlobalContext();
		return GlobalContext.self;
	}
}

export function getContext(): GlobalContext {
	return GlobalContext.get();
}

/**
 * Only call when reader context is created.
 * @returns getContext().pubContext!
 */
export function getReaderContext(): ReaderContext {
	return getContext().readerContext!;
}
