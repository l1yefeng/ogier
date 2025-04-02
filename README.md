# Ogier EPUB Reader

Small and fast.

## TODO

- [ ] Store last read location
- [ ] Redaer style: line height, margin, and font
- [ ] UI style
- [x] Show footnote in place
- [x] Show book details
- [x] Show toc
- [ ] Fetch font from archive
- [ ] Show cover
- [ ] Anchors in pages
- [x] Anchors from toc
- [ ] Drap and drop file to open

## App persistent state

### Preferences

```js
prefs = load("prefs.json")
prefs = {
    "default": {
        "lineHeight": null,
        "fontFamily": [
            "serif",
        ],
        "fontFallback": {
            "serif": ["Noto Serif"],
            "sans-serif": ["Noto Sans"],
            "Times": ["Times New Roman"],
        },
    },
    "[zh]": {},
    "books": {},
}
```

### Progress

```js
progress = load("progress.json")
progress[bookHash] = [pageIndex, locationInPage]
```
