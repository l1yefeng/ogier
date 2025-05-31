import { Store } from "@tauri-apps/plugin-store";

import { clamp, CustomStyleKey, CustomStyles, FontPrefer } from "./base";
import * as rs from "./invoke";

export class Styler {
	#readerRoot: ShadowRoot;

	#appCss: CSSStyleSheet;
	#filewiseStylesCss: CSSStyleSheet;
	#styleElemsCss: CSSStyleSheet;
	#linkedCssResources: Record<string, CSSStyleSheet>;

	#filewiseStyles: CustomStyles | null = null;
	#utf8Encoder = new TextEncoder();

	constructor(readerRoot: ShadowRoot) {
		this.#readerRoot = readerRoot;
		this.#appCss = new CSSStyleSheet();
		this.#filewiseStylesCss = new CSSStyleSheet();
		this.#styleElemsCss = new CSSStyleSheet();
		this.#linkedCssResources = {};

		this.#readerRoot.adoptedStyleSheets = [
			this.#appCss,
			this.#filewiseStylesCss,
			this.#styleElemsCss,
		];
	}

	async loadAppPrefs(store: Store): Promise<void> {
		// TODO handle malformed prefs json
		const fontSubstitute = await store.get<Record<string, string>>("font.substitute");
		const fontPrefer = await store.get<FontPrefer>("font.prefer");

		let css = ":host {";

		// font substitution
		if (fontSubstitute) {
			Object.entries(fontSubstitute).forEach(([key, value]) => {
				const property = this.#customPropertyForFont(key);
				css += `${property}: "${value}";\n`;
			});
		}

		// font prefer
		if (fontPrefer) {
			// e.g., if prefers serif, and when the font choice falls back to
			// sans-serif, users should see serif font instead of sans-serif.
			// the substitution of sans-serif won't matter.
			// the substitution of serif should be used if set.
			const property = this.#customPropertyForFont(
				fontPrefer == "serif" ? "sans-serif" : "serif",
			);
			let value = fontSubstitute && fontSubstitute[fontPrefer];
			if (!value) {
				value = fontPrefer;
			}
			// TODO: if substitution font isn't found, it still uses sans-serif.
			css += `${property}: "${value}";\n`;

			// elements that don't specify font inherit the value here
			css += `font-family: "${value}", ${fontPrefer};\n`;
		} else {
			css += `font-family: initial;\n`;
		}

		// builtin
		css += `
            img { max-width: 100%; }
			a { text-decoration: none; }
			.og-attention { background-color: #fbe54e44; }
		`;

		css += "}";

		await this.#appCss.replace(css);
	}

	load(paths: string[]): Promise<void> {
		this.#readerRoot.adoptedStyleSheets.splice(
			3,
			this.#readerRoot.adoptedStyleSheets.length - 3,
		);

		const promises = paths.map(path =>
			new Promise((resolve: (value: CSSStyleSheet) => void, reject) => {
				if (this.#linkedCssResources[path]) {
					return resolve(this.#linkedCssResources[path]);
				}

				rs.getResource(path).then(css => {
					if (!css) {
						return reject(`Resource not found: ${path}`);
					}
					const stylesheet = new CSSStyleSheet();
					stylesheet.replace(css);
					this.#linkedCssResources[path] = stylesheet;
					return resolve(stylesheet);
				});
			}).then(stylesheet => {
				this.#readerRoot.adoptedStyleSheets.push(stylesheet);
			}),
		);

		return Promise.allSettled(promises).then(results => {
			for (const result of results) {
				if (result.status == "rejected") {
					console.error(`Failed to load css: ${result.reason}`);
				}
			}
		});
	}

	setStyleElemsCss(css: string): void {
		this.#styleElemsCss.replace(css);
	}

	set filewiseStyles(value: CustomStyles) {
		this.#filewiseStyles = value;
		this.#setFilewiseStyleCss();
	}

	#setFilewiseStyleCss(): void {
		let hostStyle = "";
		if (this.#filewiseStyles) {
			const styles = this.#filewiseStyles;
			const baseFontSize = clamp(styles[CustomStyleKey.BaseFontSize], 8, 72);
			const lineHeightScale = clamp(styles[CustomStyleKey.LineHeightScale], 2, 60) / 10;
			const inlineMargin = clamp(styles[CustomStyleKey.InlineMargin], 0, 45);

			const baseFontSizeCss = baseFontSize.toFixed(2) + "px";
			const lineHeightScaleCss = lineHeightScale.toFixed(3);
			const hostLineHeightCss = (lineHeightScale * 1.25).toFixed(2);
			const inlineMarginCss = `${inlineMargin}%`;

			const host = this.#readerRoot.host as HTMLElement;
			host.style.paddingInline = inlineMarginCss;

			hostStyle = `
            :host {
                --og-line-height-scale: ${lineHeightScaleCss};
                font-size: ${baseFontSizeCss};
                line-height: ${hostLineHeightCss};
            }
			`;
		}

		this.#filewiseStylesCss.replaceSync(hostStyle);
	}

	#customPropertyForFont(name: string): string {
		let property = "--og-font-";
		const u8Arr = this.#utf8Encoder.encode(name.toLowerCase());
		u8Arr.forEach(b => {
			property += b.toString(16).padStart(2, "0");
		});
		return property;
	}
}
