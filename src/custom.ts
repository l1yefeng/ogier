/**
 * Parts of the UI that compose reader customization input in the footer.
 *
 * Concepts:
 *  There are a few *customization* possible, all configurable in the footer.
 *
 *  "customization input": UI components where user can change.
 *  "saved": stored in file, and can be loaded after app reloads/restarts.
 *  "staged": changed in the customization input.
 *  "committed": applied to the reader UI.
 */

import { CustomStyleKey, CustomStyles } from "./base";

let elemCustomizationInput: Record<CustomStyleKey, HTMLInputElement> | null = null;

export function loadCustomizationContent(): void {
	const elem = (key: CustomStyleKey) =>
		document.getElementById(`og-customization-${key}`) as HTMLInputElement;
	elemCustomizationInput = {
		[CustomStyleKey.BaseFontSize]: elem(CustomStyleKey.BaseFontSize),
		[CustomStyleKey.LineHeightScale]: elem(CustomStyleKey.LineHeightScale),
		[CustomStyleKey.InlineMargin]: elem(CustomStyleKey.InlineMargin),
	};
}

function stagedCustomStyles(): CustomStyles {
	const value = (key: CustomStyleKey) => elemCustomizationInput![key].valueAsNumber;
	return {
		[CustomStyleKey.BaseFontSize]: value(CustomStyleKey.BaseFontSize),
		[CustomStyleKey.LineHeightScale]: value(CustomStyleKey.LineHeightScale),
		[CustomStyleKey.InlineMargin]: value(CustomStyleKey.InlineMargin),
	};
}

export function commitCustomStylesFromSaved(
	saved: Partial<CustomStyles>,
	commit: (styles: CustomStyles) => void,
): void {
	let key: CustomStyleKey;
	for (key in elemCustomizationInput!) {
		const value = saved[key];
		if (value) {
			elemCustomizationInput![key].value = value.toString();
		}
	}

	commit(stagedCustomStyles());
}

export function activateCustomizationInput(
	commit: (styles: CustomStyles) => void,
	save: (styles: CustomStyles) => void,
): void {
	const listener = () => {
		const styles = stagedCustomStyles();
		commit(styles);
		save(styles);
	};

	for (const elem of Object.values(elemCustomizationInput!)) {
		elem.onchange = listener;
	}
}

export function eventTargetIsCustomizationInput(event: Event): boolean {
	for (const elem of Object.values(elemCustomizationInput!)) {
		if (elem == event.target) {
			return true;
		}
	}
	return false;
}
