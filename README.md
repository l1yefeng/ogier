# Ogier EPUB Reader

Small and fast.

## TODO

- TOC: offset 0 not working
- TOC: label too long?
- Reload: not simply get current, open same book, and reload opened stores.
- KeyDown sometimes doesn't have focus
- Use keyup and repeat. Make repeat count the distance to jump.
- Improve performance when loading styles
- Store last read location: which line
- Fetch font from archive

## App persistent state

prefs.json

```ts
type FontName = string

type PrefKey = "font.prefer" | ["font.fallbacks", FontName]
type Lang = "[zh-Hans]" | "[en]" | ...
type Key = PrefKey | [Lang, PrefKey]

// font.prefer
type Value = "sans-serif" | "serif"
// font.fallbacks
type Value = FontName[]

type Prefs = Record<Key, Value>
```

*epub-id*.json

```ts
interface PerEpubCustomization {
    baseFontSize: number;
    lineHeightScale: number;
    inlineMargin: number;
    forceLang: Lang;
    forceFont: boolean;
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
