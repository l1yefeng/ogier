import { Store } from "@tauri-apps/plugin-store";
import { ReadScreen } from "./readscreen";

export class GlobalContext {
	readScreen?: ReadScreen;
	prefsStore?: Store;

	private constructor() {}

	// Singleton
	static self?: GlobalContext;
	static get(): GlobalContext {
		if (!GlobalContext.self) GlobalContext.self = new GlobalContext();
		return GlobalContext.self;
	}
}

export function getGlobalContext(): GlobalContext {
	return GlobalContext.get();
}
