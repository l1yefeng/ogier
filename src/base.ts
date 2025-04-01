export interface EpubNavPoint {
	label: string;
	content: string;
	playOrder: number;
	children: EpubNavPoint[];
}

/**
 * Checks if `locationId` matches `elem` or nearby elements.
 *
 * @param locationId - The ID (without hash) to check.
 * @param elem - The DOM element to compare.
 * @returns `true` if `locationId` matches `elem` or a surrounding element.
 */
export function isLocationNear(locationId: string, elem: Element): boolean {
	if (elem.id == locationId) {
		return true;
	}
	for (const child of elem.children) {
		if (child.id == locationId) {
			return true;
		}
	}
	if (elem.parentElement?.id == locationId) {
		return true;
	}
	if (elem.previousElementSibling?.id == locationId) {
		return true;
	}
	if (elem.nextElementSibling?.id == locationId) {
		return true;
	}
	return false;
}

export function repairEpubHref(anchor: HTMLAnchorElement): void {
	const value = anchor.getAttribute("href");
	if (value) {
		const hashIndex = value.lastIndexOf("#");
		if (hashIndex >= 0 && value[hashIndex - 1] == "/") {
			anchor.href = value.substring(hashIndex);
		}
	}
}

export function anchoredSamePageLocation(elem: HTMLAnchorElement): string | null {
	const href = elem.getAttribute("href");
	if (href && href.startsWith("#")) {
		return href.substring(1);
	}
	return null;
}
