# Ogier EPUB Reader

Small and fast.

## TODO

- When toc shows, current nav point is in the center and focused
- Improve performance when loading styles
- External links
- Store last read location: which line
- Fetch font from archive
- Read progress: which nav item?
- Drap and drop file to open

## App persistent state

prefs.json

```ts
type FontName = string;

interface NoLangPrefs {
    fontPrefer: "sans-serif" | "serif";
    fontFallbacks: Record<FontName, FontName[]>;
}

type Lang = "[zh-Hans]" | "[en]" | ...
type PrefLang = "default" | Lang

type Prefs = Record<PrefLang, NoLangPrefs>
```

*epub-id*.json

```ts
interface PerEpubCustomization {
    baseFontSize: number;
    spacingScale: number;
    forceLang: Lang;
}
```

progress.json

```ts
interface Progess {
    positionInSpine: number;
    positionInItem: number;
}

type EpubId = string;

type Progresses = Record<EpubId, Progress>
```
