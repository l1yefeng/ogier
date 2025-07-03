# Ogier EPUB Reader

Small and fast.

## Definitions

### EPUB

- EPUB. The file format. Or, the EPUB-formatted file.
- Book.
- Content document (Page).
- Spine.
- Metadata.

### UI

### Configuration

- Reader settings. Settings that control the reader.
- Filewise styles. Settings for the reader style that apply to the current EPUB.

## TODO

- Parse EPUB myself.
- SVG content - find a test case.
- Fetch font from archive
- Other methods to customize reader (when UI is too narrow).
- Dark theme.
- New window?
- Welcome screen list recent files.
- Optimize: Open "Wild Life" faster.
- Optimize: cache; https://crates.io/crates/lru
- Optimize: css loading
- Use keyup and repeat. Make repeat count the distance to jump.
- Error handling especially in menus.rs
- Mimetype application/page-template+xml etc.

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
