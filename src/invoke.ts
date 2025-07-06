/**
 * Export all backend (rust) APIs.
 * `invoke` from Tauri API should not be used anywhere outside this file.
 *
 * TODO: include listeners.
 */

import { invoke } from "@tauri-apps/api/core";

import { AboutPub, AboutPubJson, CustomStyles, aboutPubFromJson } from "./base";

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

export function reloadBook(): Promise<AboutPub> {
	return invoke<AboutPubJson>("reload_book").then(aboutPubFromJson);
}

export function setReadingPosition(url: URL, percentage: number): Promise<void> {
	const args = { url, percentage };
	return invoke<void>("set_reading_position", args);
}
export function getReadingPosition(): Promise<[URL, number | null] | null> {
	return invoke<[string, number | null] | null>("get_reading_position").then(res => {
		if (res == null) return null;
		const [url, percentage] = res;
		return [URL.parse(url)!, percentage];
	});
}
