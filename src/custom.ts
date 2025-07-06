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

import { FilewiseStylesKey, FilewiseStyles } from "./base";

let elemCustomizationInput: Record<FilewiseStylesKey, HTMLInputElement> | null = null;

export function loadCustomizationContent(): void {
	const elem = (key: FilewiseStylesKey) =>
		document.getElementById(`og-customization-${key}`) as HTMLInputElement;
	elemCustomizationInput = {
		[FilewiseStylesKey.BaseFontSize]: elem(FilewiseStylesKey.BaseFontSize),
		[FilewiseStylesKey.LineHeightScale]: elem(FilewiseStylesKey.LineHeightScale),
		[FilewiseStylesKey.InlineMargin]: elem(FilewiseStylesKey.InlineMargin),
	};
}

function stagedCustomStyles(): FilewiseStyles {
	const value = (key: FilewiseStylesKey) => elemCustomizationInput![key].valueAsNumber;
	return {
		[FilewiseStylesKey.BaseFontSize]: value(FilewiseStylesKey.BaseFontSize),
		[FilewiseStylesKey.LineHeightScale]: value(FilewiseStylesKey.LineHeightScale),
		[FilewiseStylesKey.InlineMargin]: value(FilewiseStylesKey.InlineMargin),
	};
}

export function commitCustomStylesFromSaved(
	saved: Partial<FilewiseStyles>,
	commit: (styles: FilewiseStyles) => void,
): void {
	let key: FilewiseStylesKey;
	for (key in elemCustomizationInput!) {
		const value = saved[key];
		if (value) {
			elemCustomizationInput![key].value = value.toString();
		}
	}

	commit(stagedCustomStyles());
}

export function activateCustomizationInput(
	commit: (styles: FilewiseStyles) => void,
	save: (styles: FilewiseStyles) => void,
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
