/**
 * Export all backend (rust) APIs.
 * `invoke` from Tauri API should not be used anywhere outside this file.
 *
 * TODO: include listeners.
 *
 * TODO: lots of renaming (but, rust first).
 */

import { invoke } from "@tauri-apps/api/core";
import { CustomStyles, AboutPub, AboutPubJson, aboutPubFromJson } from "./base";

// TODO: path is URL
// export function getResource(path: URL): Promise<string> {
// 	const args = { path: path.toString() };
// 	return invoke("get_resource", args);
// }

// export function getDetails(): Promise<EpubDetails> {
// 	return invoke("get_details");
// }

// export function getToc(): Promise<EpubToc> {
// 	return invoke<Record<string, Record<string, unknown>>>("get_toc").then(result => {
// 		let toc: EpubToc;
// 		if (result["Nav"]) {
// 			const parser = new DOMParser();
// 			const { xhtml, path } = result["Nav"];
// 			const navDoc = parser.parseFromString(xhtml as string, "application/xhtml+xml");
// 			const lang = navDoc.documentElement.lang;
// 			const nav = navDoc.querySelector<HTMLElement>("nav:has(>ol)");
// 			if (!nav) {
// 				throw new Error("TOC nav not found.");
// 			}
// 			toc = { kind: "nav", nav, path: new URL(path as string), lang };
// 		} else if (result["Ncx"]) {
// 			const { root } = result["Ncx"];
// 			toc = { kind: "ncx", root: root as EpubNavPoint, lang: "" };
// 		} else {
// 			throw new Error("Not Reached");
// 		}
// 		return toc;
// 	});
// }

export function getCustomStyles(): Promise<Partial<CustomStyles> | null> {
	return invoke<string>("get_custom_stylesheet").then(savedSettings => {
		if (savedSettings) {
			const styles: CustomStyles = JSON.parse(savedSettings);
			return styles;
		} else {
			return null;
		}
	});
}

export function setCustomStyles(styles: CustomStyles): Promise<void> {
	const args = { content: JSON.stringify(styles, undefined, 2) };
	return invoke("set_custom_stylesheet", args);
}

export function openEpub(path: string): Promise<AboutPub> {
	const args = { path };
	return invoke<AboutPubJson>("open_epub", args).then(aboutPubFromJson);
}

export function openEpubIfLoaded(): Promise<AboutPub | null> {
	return invoke<AboutPubJson | null>("open_epub_if_loaded").then(json =>
		json != null ? aboutPubFromJson(json) : null,
	);
}

// // TODO: Rename the API
// export function moveInSpine(next: boolean) {
// 	const args = { next };
// 	return invoke<SpineItemData | null>("navigate_adjacent", args).then(result =>
// 		result ? jsonToSpineItemData(result) : null,
// 	);
// }

// export function moveToInSpine(url: URL) {
// 	const args = { path: url.toString() };
// 	return invoke<SpineItemData>("navigate_to", args).then(jsonToSpineItemData);
// }

export function reloadBook(): Promise<AboutPub> {
	return invoke<AboutPubJson>("reload_book").then(aboutPubFromJson);
}

// export function setReadingPosition(position: number): Promise<void> {
// 	const args = { position };
// 	return invoke("set_reading_position", args);
// }
