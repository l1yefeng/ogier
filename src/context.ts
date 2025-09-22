import { LazyStore } from "@tauri-apps/plugin-store";
import { ReadScreen } from "./readscreen";

export class GlobalContext {
	readScreen?: ReadScreen;
	prefsStore?: LazyStore;

	private constructor() {}

	// Singleton
	private static self?: GlobalContext;
	static get(): GlobalContext {
		if (!GlobalContext.self) GlobalContext.self = new GlobalContext();
		return GlobalContext.self;
	}
}

export function getGlobalContext(): GlobalContext {
	return GlobalContext.get();
}
