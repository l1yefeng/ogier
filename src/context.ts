import { Store } from "@tauri-apps/plugin-store";
import { AboutPub } from "./base";

export class Context {
	/**
	 * Opened EPUB's (static) info.
	 */
	static openedEpub: AboutPub | null = null;

	static readingPositionUrl: URL | null = null;
	private static readingPositionInSpine: number | null = null;
	static readingPositionPercentage = 0.0;

	private static epubLang: string | null = null;
	static spineItemLang = "";

	static prefsStore?: Store;

	static getEpubLang(): string {
		if (Context.epubLang == null) {
			const langData = Context.openedEpub!.pubMetadata.find(item => item.property == "lang");
			Context.epubLang = langData?.value ?? "";
		}
		return Context.epubLang;
	}

	static getReadingPositionInSpine(): number {
		if (Context.readingPositionInSpine == null) {
			const current = Context.readingPositionUrl!;
			let i = Context.openedEpub!.pubSpine.findIndex(url => url.pathname == current.pathname);
			if (i < 0) {
				console.error(`Did not find ${current} in spine`);
				i = 0;
			}
			Context.readingPositionInSpine = i;
		}
		return Context.readingPositionInSpine;
	}
}
