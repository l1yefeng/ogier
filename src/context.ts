import { Store } from "@tauri-apps/plugin-store";
import { AboutPub } from "./base";

export class Context {
	/**
	 * Opened EPUB's (static) info.
	 */
	static openedEpub: AboutPub | null = null;

	static readingPositionUrl: URL | null = null;
	static readingPositionInSpine: number | null = null;
	static readingPositionPercentage = 0.0;

	static epubLang = "";
	static spineItemLang = "";
	static spineLength?: number;

	static prefsStore?: Store;
}
