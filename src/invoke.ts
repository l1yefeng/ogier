import { invoke } from "@tauri-apps/api/core";
import { CustomStyles, EpubMetadata, EpubNavPoint, SpineItemData } from "./base";

export function getResource(path: string): Promise<string> {
	const args = { path };
	return invoke("get_resource", args);
}

export function getMetadata(): Promise<EpubMetadata> {
	return invoke("get_metadata");
}

export function getToc(): Promise<EpubNavPoint> {
	return invoke("get_toc");
}

export function getCustomStyles(): Promise<CustomStyles | null> {
	return invoke("get_custom_stylesheet").then(result => {
		const savedSettings = result as string;
		if (savedSettings) {
			const styles: CustomStyles = JSON.parse(savedSettings);
			return styles;
		} else {
			return null;
		}
	});
}

export function setCustomStyles(styles: CustomStyles): Promise<void> {
	const args = { content: JSON.stringify(styles) };
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

export function moveToInSpine(path: string): Promise<SpineItemData | null> {
	const args = { path };
	return invoke("navigate_to", args);
}
