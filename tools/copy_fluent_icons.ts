const ICONS = [
	"arrow_hook_up_left",
	"arrow_next",
	"arrow_previous",
	"book",
	"document_margins",
	"notebook_arrow_curve_down",
	"text_font_size",
	"text_line_spacing",
];

async function copy(icon: string): Promise<void> {
	for (let size = 24; size > 0; size -= 2) {
		const filename = `${icon}_${size}_regular.svg`;
		const input = Bun.file(`node_modules/@fluentui/svg-icons/icons/${filename}`);
		if (!(await input.exists())) {
			continue;
		}
		const output = Bun.file(`src/assets/fluent/${filename}`);
		await Bun.write(output, input);
		return;
	}

	throw new Error(`Icon ${icon} not found.`);
}

await Promise.all(ICONS.map(copy));

export {};
