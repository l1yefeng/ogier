/**
 * Export all backend (rust) APIs.
 * `invoke` or `listen` from Tauri API should not be used anywhere
 * outside this file.
 */

import { invoke } from "@tauri-apps/api/core";

import {
	AboutPub,
	AboutPubJson,
	FilewiseStyles,
	FontPrefer,
	UrlAndPercentage,
	aboutPubFromJson,
} from "./base";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/window";

export function getFilewiseStyles(): Promise<Partial<FilewiseStyles> | null> {
	return invoke<string>("get_filewise_styles").then(savedSettings => {
		if (savedSettings) {
			const styles: FilewiseStyles = JSON.parse(savedSettings);
			return styles;
		} else {
			return null;
		}
	});
}

export function setFilewiseStyles(styles: FilewiseStyles): Promise<void> {
	const args = { content: JSON.stringify(styles, undefined, 2) };
	return invoke("set_filewise_styles", args);
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
export function getReadingPosition(): Promise<UrlAndPercentage | null> {
	return invoke<[string, number | null] | null>("get_reading_position").then(res => {
		if (res == null) return null;
		const [url, percentage] = res;
		return [URL.parse(url)!, percentage];
	});
}

export function setDragDropHandler(handler: (paths: string[]) => any): void {
	getCurrentWebviewWindow().listen<{
		paths: string[];
		position: PhysicalPosition;
	}>("tauri://drag-drop", event => handler(event.payload.paths));
}

export function setMenuHandlerForFileOpen(handler: () => any): void {
	getCurrentWebviewWindow().listen("menu/f_o", handler);
}

export function setMenuHandlerFotFileDetails(handler: () => any): void {
	getCurrentWebviewWindow().listen("menu/f_d", handler);
}

export function setMenuHandlerFotFileNavigate(handler: () => any): void {
	getCurrentWebviewWindow().listen("menu/f_n", handler);
}

export function setMenuHandlerForViewFontPrefers(
	handler: (fontPrefer: FontPrefer) => any,
): void {
	getCurrentWebviewWindow().listen<FontPrefer>("menu/v_fp", event => handler(event.payload));
}
