# Bundled fonts

All are SIL Open Font License 1.1 (full text in the `*-OFL.txt` next to them). Static TrueType files, copied
unmodified from the upstream releases below (so the license's reserved font names stay valid). Shipped to
`<resources>/fonts/` and passed to the engine as `REELENGINE_FONTS`.

| Family | Files | Upstream | SHA-256 of the upstream archive |
|---|---|---|---|
| Montserrat | Regular, Medium, SemiBold, Bold, ExtraBold | https://github.com/JulietaUla/Montserrat tag v7.222, `fonts/ttf/` (files fetched individually) | n/a (git tag) |
| Inter 4.1 | Regular, Medium, SemiBold, Bold | https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip `extras/ttf/` | `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e` |
| Roboto 3.016 | Regular, Medium, Bold | https://github.com/googlefonts/roboto-3-classic/releases/download/v3.016/Roboto_v3.016.zip `hinted/static/` | `1653dbe12f248da8fb0b9920db7b9496cd677ed3981154f6f15285c8bd4e334f` |
| Fraunces 1.000 | Regular, SemiBold, Bold (the 72pt optical size) | https://github.com/undercasetype/Fraunces/releases/download/1.000/UnderCaseType_Fraunces_1.000.zip `Fonts - Desktop/static/ttf/` | `8d8b81dfaeb89433f5c908e1d8d0a4b202bd627bd80d4cd5ff56f311fdcad19f` |

The files are committed so a build needs no network for fonts. `packaging/fetch_fonts.py` re-creates this
folder from the upstream sources and verifies the archives.
