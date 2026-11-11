# Session fixtures

Pages for `classify.spec.ts`. The `hand-made` ones were written from public page shapes and hold no personal data. `signed-out-login.html` is LinkedIn's public login page, saved with Ctrl+S from a Chrome guest window on 2026-11-11 (signed-out `/feed/` redirected to `/login`, and `/login` saved the same page) and scrubbed: every script, style, meta, embedded JSON, hidden input, id, class and URL removed, leaving the structure, the visible text and the inputs' `type`/`autocomplete`.

The fixture test reads this table and fails on a fixture file without a row. To add a fixture, add the file and one row. A file may have several rows: the `/feed/` row of `checkpoint-challenge.html` makes its challenge marker, not the `/checkpoint/` path, decide the result.

| file                      | path                   | expected       | source                 | scrubbed |
| ------------------------- | ---------------------- | -------------- | ---------------------- | -------- |
| signed-in-feed.html       | /feed/                 | signed-in      | hand-made              | yes      |
| checkpoint-challenge.html | /checkpoint/challenge/ | security-check | hand-made              | yes      |
| checkpoint-challenge.html | /feed/                 | security-check | hand-made              | yes      |
| signed-out-login.html     | /login                 | signed-out     | guest save, 2026-11-11 | yes      |
| signed-out-login.html     | /feed/                 | signed-out     | guest save, 2026-11-11 | yes      |
