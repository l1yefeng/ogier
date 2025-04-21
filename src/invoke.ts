/**
 * Export all backend (rust) APIs.
 * `invoke` from Tauri API should not be used anywhere outside this file.
 *
 * TODO: include listeners.
 */

import { invoke } from "@tauri-apps/api/core";
import { CustomStyles, EpubDetails, EpubNavPoint, EpubToc, SpineItemData } from "./base";

export function getResource(path: string): Promise<string> {
	const args = { path };
	return invoke("get_resource", args);
}

export function getDetails(): Promise<EpubDetails> {
	return invoke("get_details");
}

export function getToc(): Promise<EpubToc> {
	return invoke<Record<string, Record<string, unknown>>>("get_toc").then(result => {
		let toc: EpubToc;
		console.debug(result);
		if (result["Nav"]) {
			const parser = new DOMParser();
			const { xhtml, path } = result["Nav"];
			const navDoc = parser.parseFromString(xhtml as string, "application/xhtml+xml");
			const nav = navDoc.querySelector<HTMLElement>("nav:has(>ol)");
			if (!nav) {
				throw new Error("TOC nav not found.");
			}
			toc = { kind: "nav", nav, path: path as string };
		} else if (result["Ncx"]) {
			const { root } = result["Ncx"];
			toc = { kind: "ncx", root: root as EpubNavPoint };
		} else {
			throw new Error("Not Reached");
		}
		return toc;
	});
}

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

export function openEpub(): Promise<SpineItemData | null> {
	return invoke("open_epub");
}

// TODO: Rename the API
export function moveInSpine(next: boolean): Promise<SpineItemData | null> {
	const args = { next };
	return invoke("navigate_adjacent", args);
}

export function moveToInSpine(path: string): Promise<SpineItemData> {
	const args = { path };
	return invoke("navigate_to", args);
}

export function reloadCurrent(): Promise<SpineItemData> {
	return invoke("reload_current");
}
