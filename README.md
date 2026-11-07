# 31 Palabras

Learn a language from TV: watch an episode beside its matched transcripts, look up
words in place, and turn them into flashcards that replay the scene they came
from. Built for *31 Minutos* and Chilean Spanish; also works for French, German
and Portuguese series. Translations are always into English.

## Run

Needs Node 22.9+ and `ffmpeg` on your PATH.

```bash
npm install
```

```bash
npm start
```

Then open <http://localhost:3131> in Chrome or Firefox. Many videos are AV1, which
Safari can't play on older Macs.

## Using it

- **Look up:** click a word, or drag across a phrase. The video pauses and the
  panel shows PONS (Google Translate for a phrase). The **Source** dropdown switches
  to Google Translate, Wiktionary, Linguee or DeepL. If PONS has nothing for a word,
  the panel moves on to Wiktionary, then Google Translate, and says so. For a verb, PONS adds
  which form you clicked, a preview of its tables and a link to the full ones.
- **Flashcard:** click any result to add it to the meaning, then **Add to deck**.
  Saved terms are underlined in every episode of that language.
- **Highlight:** marks that spot in this episode; **Highlights** lists them when
  nothing is selected.
- **Correct a line:** hover over a line and choose **Edit**. Edited lines get a dot
  by the time, and **Restore original** undoes the edit. `Cmd`/`Ctrl`+`Enter` saves
  and `Esc` cancels. Your subtitle files aren't changed.
- **Fix the timing:** if subtitles are off, pause where a line is spoken, hover over
  it and choose **Sync**. One synced line shifts the whole transcript; two or more
  also stretch the timing between them, which fixes drift and estimated timing.
  **Unsync** releases a line and **Reset sync** restores the original timing. Your
  subtitle files aren't changed, and flashcard clips move with the sync.
- **View menu:** choose what's **Over the video** (off, either language or both) and
  in the **Transcript** (both, one language or none). For example, Spanish over the
  video with English on the side. Subtitles over the video can be clicked for lookups
  too. **Text size** changes the transcript, subtitles and lookup panel.
- **Resize the video:** drag the bar between the video and the transcript, or use
  **Video size** in the View menu. **Fullscreen** keeps the subtitles.
- **Keys:** `Space` play/pause, `←` `→` previous/next line, `R` replay, `L` loop,
  `E` hide English, `F` fullscreen, `Esc` close the lookup.
- **Review:** `Space` shows the answer, `1`-`4` grades it, `P` plays the scene.
- **Deck → Export for Anki:** a tab-separated file Anki can import directly.

## Adding a series

Copy `series.example.json` to `series.json`, list your series, and restart:

```json
[
  { "id": "31-minutos", "title": "31 Minutos", "root": "/Volumes/mccann_ssd/31 minutos", "language": "es" },
  { "id": "dark", "title": "Dark", "root": "/Volumes/mccann_ssd/Dark", "language": "de" }
]
```

- `language` is `es`, `fr`, `de` or `pt`.
- `id` is permanent, because cards and highlights refer to it. Keep `31-minutos`
  for that show, since existing cards use it.
- On Windows, write paths with forward slashes: `D:/Shows/Dark`.
- Without a `series.json`, the app shows 31 Minutos only, from `SHOW_ROOT` if set.

Episodes must be in folders like `Season 1/01 - Title/`. Each folder holds either
one video file with its audio built in, or separate video and audio files. With
several audio tracks, the one in the series' language is used if it's labeled.

Video has to be H.264, AV1, VP9 or HEVC (HEVC only plays in some browsers); others
need converting first. Audio that browsers can't play, like AC3, is converted
automatically, which takes longer the first time you open that episode.

## Adding subtitles

Put a file in the episode's folder named `<anything>.<language>.<format>`, then
restart the app:

| Language | Codes, most preferred first |
| --- | --- |
| English | `en`, `en-US`, `en-GB`, `eng` |
| Spanish | `es-419`, `es`, `es-ES`, `es-MX`, `spa` |
| French | `fr`, `fr-FR`, `fr-CA`, `fra`, `fre` |
| German | `de`, `de-DE`, `deu`, `ger` |
| Portuguese | `pt-BR`, `pt`, `pt-PT`, `por` |

Formats are `.vtt`, `.srt`, `.txt`, `.md` and `.rtf`, for example
`05 - Monstruo Chupachupa.es-419.txt`. If a language has several files, `.vtt` wins,
then `.srt`, `.txt`, `.md`, `.rtf`. A track needs at least 10 lines to be used.

Text files can have timestamps at the start of lines, or on their own line above
the text:

```text
0:05 Hola, ¿cómo estás?
[0:09] Muy bien, gracias.
1:02:30 - Hasta luego.
```

Without at least three timestamps, the text is spread across the episode in
proportion to line length and the transcript is marked as estimated. It won't
follow the video exactly and may not pair up correctly with the other language.

Timed subtitles have to match your copy of the video, because lines are paired
purely by time. Changing an episode's subtitles re-pairs its lines, so its
highlights can land on the wrong words and its corrections may stop applying.

## Lookup sources

| Source | Key needed | Used for |
| --- | --- | --- |
| PONS (unofficial) | no | Dictionary entries with regional labels; verb tables for Spanish, French and German |
| Wiktionary | no | Definitions; the best coverage of Chilean slang |
| Linguee (unofficial) | no | Dictionary entries, phrases, example sentences |
| DeepL | `DEEPL_API_KEY` in `.env` | Translation, only when you press **Ask DeepL** |
| Google Translate (unofficial) | no | Automatic translation |
| MyMemory | no | Automatic translation if Google is unavailable |

PONS, Linguee and Google's keyless endpoint aren't official APIs and can refuse
requests. A refused provider is left alone for 15 minutes, and results are cached
until the server restarts. Only the text you select, plus its subtitle line when
DeepL is on, is sent to these services.

DeepL's free allowance doesn't renew, so it never runs by itself. With a key set,
it joins the **Source** dropdown, and **Ask DeepL** shows what it will cost before
anything is spent. Its answers
are saved so the same text is never paid for twice, and the panel and the Deck page
show how much has been used.

## Where things are stored

- `data/study.json`: your cards, highlights, transcript corrections and timing fixes. Back this up.
- `data/translations.json`: saved DeepL translations; safe to delete, but they'd be
  paid for again.
- `~/Library/Caches/31-palabras`: playable copies of recent episodes. Only the last
  5 are kept (about 280 MB each for 31 Minutos); safe to delete.

Episode folders are only ever read.

## Tests

```bash
npm test
```
