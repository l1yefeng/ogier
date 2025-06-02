import { Store } from "@tauri-apps/plugin-store";

export class Context {
	static epubLang = "";
	static spineItemLang = "";
	static spineLength?: number;

	static prefsStore?: Store;
}
