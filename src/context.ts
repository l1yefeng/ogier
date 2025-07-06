import { Store } from "@tauri-apps/plugin-store";

import { AboutPub } from "./base";

export class Context {
	/**
	 * Opened EPUB's (static) info.
	 */
	private static openedEpub: AboutPub | null = null;

	private static spineIndex: Map<string, number> | null = null;
	// FIXME: what if non-linear spine item?
	private static readingPosition: [URL, number] | null = null;

	private static epubLang: string | null = null;
	private static epubTitle: string | null = null;
	static spineItemLang = "";

	static prefsStore?: Store;

	static setOpenedEpub(aboutPub: AboutPub): void {
		Context.openedEpub = aboutPub;
		Context.epubLang = null;
		Context.spineIndex = null;
	}

	static getOpenedEpub(): AboutPub {
		if (Context.openedEpub == null) {
			throw new Error("getOpenedEpub is called when it should not be");
		}
		return Context.openedEpub;
	}

	static getEpubLang(): string {
		if (Context.epubLang == null) {
			const data = Context.getOpenedEpub().pubMetadata.find(
				item => item.property == "language",
			);
			Context.epubLang = data?.value ?? "";
		}
		return Context.epubLang;
	}

	static getEpubTitle(): string {
		if (Context.epubTitle == null) {
			const data = Context.getOpenedEpub().pubMetadata.find(item => item.property == "title");
			let title = data?.value;
			if (!title) {
				const path = Context.getOpenedEpub().filePath;
				const i = path.lastIndexOf("/");
				const j = path.lastIndexOf("\\");
				title = path.slice((i > j ? i : j) + 1);
			}
			Context.epubTitle = title;
		}
		return Context.epubTitle;
	}

	private static getSpineIndex(): Map<string, number> {
		if (Context.spineIndex == null) {
			const m = new Map<string, number>();
			Context.getOpenedEpub().pubSpine.forEach((url, index) => {
				m.set(url.pathname, index);
			});
			Context.spineIndex = m;
		}
		return Context.spineIndex;
	}

	static setReadingPositionUrl(url: URL): void {
		const index = Context.getSpineIndex().get(url.pathname)!;
		Context.readingPosition = [url, index];
	}

	static setReadingPositionInSpine(index: number): void {
		const url = Context.getOpenedEpub().pubSpine[index];
		Context.readingPosition = [url, index];
	}

	static getReadingPositionUrl(): URL {
		if (Context.readingPosition == null) {
			throw new Error("getReadingPositionUrl is called when it should not be");
		}
		return Context.readingPosition[0];
	}

	static getReadingPositionInSpine(): number {
		if (Context.readingPosition == null) {
			throw new Error("getReadingPositionInSpine is called when it should not be");
		}
		return Context.readingPosition[1];
	}
}
