# Apply fixtures

Real LinkedIn pages saved by `runner snapshot` on 2026-11-12, scrubbed by `runner snapshot scrub`, and read by Claude for personal data before commit. The two nodes that belong to the author's own browser extensions (screen recorder and video companion) were removed from every file.

`review-one-page.html` is a one-page form: its only primary button is "Submit application", while it still has contact and resume fields.

| file                          | kind        | source                                   | scrubbed |
| ----------------------------- | ----------- | ---------------------------------------- | -------- |
| job-page.html                 | job         | snapshot, 2026-11-12, job A job page     | yes      |
| job-page-2.html               | job         | snapshot, 2026-11-12, job B job page     | yes      |
| job-applied.html              | job-applied | snapshot, 2026-11-12, job C after submit | yes      |
| step-contact.html             | step        | snapshot, 2026-11-12, job D step 1       | yes      |
| step-contact-email-phone.html | step        | snapshot, 2026-11-12, job A step 1       | yes      |
| step-resume.html              | step        | snapshot, 2026-11-12, job A step 2       | yes      |
| step-questions.html           | step        | snapshot, 2026-11-12, job B step 3       | yes      |
| step-questions-2.html         | step        | snapshot, 2026-11-12, job A step 3       | yes      |
| step-questions-location.html  | step        | snapshot, 2026-11-12, job D step 3       | yes      |
| review-one-page.html          | review      | snapshot, 2026-11-12, job E review       | yes      |
| review.html                   | review      | snapshot, 2026-11-12, job A review       | yes      |
| review-save-prompt.html       | review      | snapshot, 2026-11-12, job B save prompt  | yes      |
