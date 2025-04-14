# Ogier EPUB Reader

Small and fast.

## TODO

- EPUB3
- key events: keyup is sometimes accidental; KeyDown sometimes doesn't have focus
- Improve performance when loading styles
- Store last read location: which line
- Fetch font from archive
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
