# Ogier EPUB Reader

Small and fast.

## TODO

- [ ] BUG: Page location should be 0 when next page, not the same
- [ ] CSS absolute length other than px
- [x] Fix menu item
- [x] Store last read location: which page
- [ ] Store last read location: which line
- [ ] Reader style: line height
- [ ] Reader style: margin
- [x] Reader style: font
- [ ] Reader style: line height, margin, and font
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
