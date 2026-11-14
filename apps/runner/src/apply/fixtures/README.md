# Apply fixtures

Real LinkedIn pages saved by `runner snapshot` on 2026-11-12 (and 2026-11-14 for job G), scrubbed by `runner snapshot scrub`, and read by Claude for personal data before commit. The two nodes that belong to the author's own browser extensions (screen recorder and video companion) were removed from every file.

`review-backdrop-prompt.html` is a contact step with LinkedIn's "Save this application?" prompt open over it, after a press landed on the backdrop. Its kind is `step` because the form behind the prompt still reads as one; the page has two Dismiss buttons, the form's and the prompt's.

`review-follow.html` is a review page (job G, 2026-11-14) with LinkedIn's "Follow <company> to stay up to date with their page" checkbox inside the form dialog. The earlier review captures carry the same checkbox; the captures hold no checked state, which the runner reads live.

`sent-dialog-2.html` is the job page with LinkedIn's "Your application was sent" dialog open over it, right after the author's own submit on job G. It also reads as an applied job page (its "Application status" heading, no Easy Apply button), so it is listed as `job-applied`. No separate capture of the job page after that dialog was closed exists, so there is no `job-applied-2.html`.

`review-one-page.html` is a one-page form: its only primary button is "Submit application", while it still has contact and resume fields.

| file                          | kind        | source                                                          | scrubbed |
| ----------------------------- | ----------- | --------------------------------------------------------------- | -------- |
| job-page.html                 | job         | snapshot, 2026-11-12, job A job page                            | yes      |
| job-page-2.html               | job         | snapshot, 2026-11-12, job B job page                            | yes      |
| job-applied.html              | job-applied | snapshot, 2026-11-12, job C after submit                        | yes      |
| step-contact.html             | step        | snapshot, 2026-11-12, job D step 1                              | yes      |
| step-contact-email-phone.html | step        | snapshot, 2026-11-12, job A step 1                              | yes      |
| step-resume.html              | step        | snapshot, 2026-11-12, job A step 2                              | yes      |
| step-questions.html           | step        | snapshot, 2026-11-12, job B step 3                              | yes      |
| step-questions-2.html         | step        | snapshot, 2026-11-12, job A step 3                              | yes      |
| step-questions-location.html  | step        | snapshot, 2026-11-12, job D step 3                              | yes      |
| review-one-page.html          | review      | snapshot, 2026-11-12, job E review                              | yes      |
| review.html                   | review      | snapshot, 2026-11-12, job A review                              | yes      |
| review-save-prompt.html       | review      | snapshot, 2026-11-12, job B save prompt                         | yes      |
| review-backdrop-prompt.html   | step        | snapshot, 2026-11-12, job F step 1 with the save prompt over it | yes      |
| review-follow.html            | review      | snapshot, 2026-11-14, job G review                              | yes      |
| sent-dialog-2.html            | job-applied | snapshot, 2026-11-14, job G after submit, sent dialog open      | yes      |
