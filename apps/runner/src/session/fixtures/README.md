# Session fixtures

Minimal hand-made pages for `classify.spec.ts`. None is a real LinkedIn capture; they were written from public page shapes and hold no personal data (scrubbed: nothing to scrub).

The fixture test reads this table and fails on a fixture file without a row. To add a fixture, add the file and one row. A file may have several rows: the `/feed/` row of `checkpoint-challenge.html` makes its challenge marker, not the `/checkpoint/` path, decide the result.

| file                      | path                   | expected       | source    | scrubbed |
| ------------------------- | ---------------------- | -------------- | --------- | -------- |
| signed-in-feed.html       | /feed/                 | signed-in      | hand-made | yes      |
| checkpoint-challenge.html | /checkpoint/challenge/ | security-check | hand-made | yes      |
| checkpoint-challenge.html | /feed/                 | security-check | hand-made | yes      |
